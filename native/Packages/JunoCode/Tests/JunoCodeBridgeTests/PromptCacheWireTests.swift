import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoCodeBridge
import JunoCodeCore
import JunoCodeRuntime

/// A provider's prefix cache only hits when a request begins with exactly the
/// bytes the last one did, and only routes to the right cache when the
/// request says which conversation it belongs to.
final class PromptCacheWireTests: XCTestCase {
    private let accountID = try! AccountID("account-1")
    private let sessionID = CodeSessionID(value: "session-cache-1")

    private final class RecordingStreamer: NativeAuthenticatedByteStreaming, @unchecked Sendable {
        private(set) var requests: [NativeBearerRequest] = []

        func stream(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPByteStreamResponse {
            requests.append(request)
            throw AgentModelClientError.transport(message: "recorded")
        }
    }

    /// A schema built in a different insertion order and table size each
    /// time, the way two launches (or two tool registries) would build it.
    private func object(_ pairs: [(String, JSONValue)], variant: Int) -> JSONValue {
        var fields = [String: JSONValue](minimumCapacity: pairs.count + variant * 7)
        let ordered = variant.isMultiple(of: 2) ? pairs : pairs.reversed()
        for (key, value) in ordered.shifted(by: variant) { fields[key] = value }
        return .object(fields)
    }

    private func request(_ modelID: String, variant: Int) -> ModelTurnRequest {
        let properties = object([
            ("path", object([("type", "string"), ("description", "File path")], variant: variant)),
            ("offset", object([("type", "integer"), ("minimum", 0)], variant: variant)),
            ("limit", object([("type", "integer"), ("maximum", 2_000)], variant: variant)),
            ("encoding", object([("type", "string"), ("enum", ["utf8", "latin1"])], variant: variant)),
        ], variant: variant)
        let schema = object([
            ("type", "object"),
            ("properties", properties),
            ("required", ["path"]),
            ("additionalProperties", false),
        ], variant: variant)
        let replayed = object([
            ("path", "Sources/App.swift"),
            ("offset", 10),
            ("limit", 200),
            ("options", object([("follow", true), ("depth", 3), ("mode", "fast")], variant: variant)),
        ], variant: variant)
        return ModelTurnRequest(
            sessionID: sessionID,
            systemPrompt: "You are a careful coding agent.",
            messages: [
                .user("Read the app file."),
                .assistant("Reading it."),
                .toolCall(id: "call-1", name: "read_file", input: replayed),
                .toolResult(id: "call-1", content: "struct App {}", isError: false),
            ],
            tools: [
                ModelToolDescriptor(name: "read_file", description: "Reads a file.", inputSchema: schema),
                ModelToolDescriptor(name: "grep", description: "Searches.", inputSchema: schema),
            ],
            modelID: modelID,
            reasoningEffort: nil
        )
    }

    private func recordedBodies(_ modelID: String, times: Int = 20) async throws -> [NativeBearerRequest] {
        let streamer = RecordingStreamer()
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        for variant in 0..<times {
            do { for try await _ in client.streamTurn(request(modelID, variant: variant)) {} } catch {}
        }
        XCTAssertEqual(streamer.requests.count, times)
        return streamer.requests
    }

    private func json(_ data: Data?) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(data))
    }

    // MARK: Byte stability

    func testAnthropicRequestIsTheSameBytesEveryTime() async throws {
        let requests = try await recordedBodies("anthropic:claude-sonnet-5")
        let bodies = Set(requests.compactMap(\.body))
        XCTAssertEqual(bodies.count, 1, "every encoding of the same request must be identical")
        let text = try XCTUnwrap(String(data: XCTUnwrap(bodies.first), encoding: .utf8))
        XCTAssertTrue(text.contains(#""input":{"limit":200,"offset":10,"options":{"depth":3,"follow":true,"mode":"fast"},"path":"Sources\/App.swift"}"#), text)
    }

    func testOpenAIChatRequestIsTheSameBytesEveryTime() async throws {
        let requests = try await recordedBodies("openai:gpt-5.4")
        XCTAssertEqual(Set(requests.compactMap(\.body)).count, 1)
        let body = try json(requests[0].body)
        let messages = try XCTUnwrap(body["messages"]?.arrayValue)
        let arguments = try XCTUnwrap(messages[2]["tool_calls"]?.arrayValue?.first?["function"]?["arguments"]?.stringValue)
        XCTAssertEqual(
            arguments,
            #"{"limit":200,"offset":10,"options":{"depth":3,"follow":true,"mode":"fast"},"path":"Sources\/App.swift"}"#
        )
    }

    func testResponsesAndOtherLabsAreTheSameBytesEveryTime() async throws {
        for model in ["openai:gpt-5.3-codex", "deepseek:deepseek-v4", "qwen:qwen3.8-max"] {
            let requests = try await recordedBodies(model, times: 8)
            XCTAssertEqual(Set(requests.compactMap(\.body)).count, 1, model)
        }
    }

    // MARK: Routing

    func testOpenAIMistralAndMetaChatSendTheSessionAsPromptCacheKey() async throws {
        for model in ["openai:gpt-5.4", "mistral:mistral-large-3", "meta:muse-spark"] {
            let sent = try await recordedBodies(model, times: 1)[0]
            XCTAssertEqual(try json(sent.body)["prompt_cache_key"]?.stringValue, "session-cache-1", model)
            XCTAssertNil(sent.headers["x-grok-conv-id"], model)
        }
    }

    func testOpenAIModernModelsGetCacheOptionsAndASystemBreakpoint() async throws {
        let body = try json(try await recordedBodies("openai:gpt-5.6", times: 1)[0].body)
        XCTAssertEqual(body["prompt_cache_options"]?["mode"]?.stringValue, "implicit")
        XCTAssertEqual(body["prompt_cache_options"]?["ttl"]?.stringValue, "30m")
        XCTAssertNil(body["prompt_cache_retention"])
        let system = try XCTUnwrap(body["messages"]?.arrayValue?.first)
        XCTAssertEqual(system["role"]?.stringValue, "system")
        let part = try XCTUnwrap(system["content"]?.arrayValue?.last)
        XCTAssertEqual(part["text"]?.stringValue, "You are a careful coding agent.")
        XCTAssertEqual(part["prompt_cache_breakpoint"]?["mode"]?.stringValue, "explicit")
    }

    func testOnlyOpenAIsListedOlderModelsGet24hRetention() async throws {
        for model in ["openai:gpt-5.4", "openai:gpt-4.1-2025-04-14"] {
            let body = try json(try await recordedBodies(model, times: 1)[0].body)
            XCTAssertEqual(body["prompt_cache_retention"]?.stringValue, "24h", model)
            XCTAssertNil(body["prompt_cache_options"], model)
            XCTAssertEqual(body["messages"]?.arrayValue?.first?["content"]?.stringValue, "You are a careful coding agent.", model)
        }
        XCTAssertTrue(PromptCacheWire.usesOpenAIRetention("gpt-5.1-codex-max"))
        for model in ["gpt-5.4-mini", "gpt-5-mini", "gpt-5.3-codex", "gpt-5.6", "gpt-6.1-sol"] {
            XCTAssertFalse(PromptCacheWire.usesOpenAIRetention(model), model)
        }
        XCTAssertTrue(PromptCacheWire.isOpenAIModernCacheModel("gpt-6.1-sol"))
        XCTAssertFalse(PromptCacheWire.isOpenAIModernCacheModel("gpt-5.5"))
        let mistral = try json(try await recordedBodies("mistral:mistral-large-3", times: 1)[0].body)
        XCTAssertNil(mistral["prompt_cache_retention"])
        XCTAssertNil(mistral["prompt_cache_options"])
    }

    func testXAIChatRoutesByHeaderNotBody() async throws {
        let sent = try await recordedBodies("xai:grok-4.7", times: 1)[0]
        XCTAssertEqual(sent.headers["x-grok-conv-id"], "session-cache-1")
        XCTAssertNil(try json(sent.body)["prompt_cache_key"], "xAI's Chat Completions has no body field for it")
        XCTAssertEqual(sent.headers["Accept"], "text/event-stream")
    }

    func testResponsesSendsPromptCacheKey() async throws {
        let sent = try await recordedBodies("openai:gpt-5.3-codex", times: 1)[0]
        XCTAssertEqual(try json(sent.body)["prompt_cache_key"]?.stringValue, "session-cache-1")
    }

    func testAutomaticCachingLabsGetNothingExtra() async throws {
        for model in ["deepseek:deepseek-v4", "zhipu:glm-5", "moonshot:kimi-k2.7", "minimax:minimax-m3"] {
            let sent = try await recordedBodies(model, times: 1)[0]
            let body = try json(sent.body)
            XCTAssertNil(body["prompt_cache_key"], model)
            XCTAssertNil(sent.headers["x-grok-conv-id"], model)
            let system = try XCTUnwrap(body["messages"]?.arrayValue?.first)
            XCTAssertEqual(system["content"]?.stringValue, "You are a careful coding agent.", model)
        }
    }

    func testQwenExplicitCacheMarksTheSystemPromptAndTheNewestMessage() async throws {
        let sent = try await recordedBodies("qwen:qwen3.8-max", times: 1)[0]
        let body = try json(sent.body)
        XCTAssertNil(body["prompt_cache_key"])
        let messages = try XCTUnwrap(body["messages"]?.arrayValue)

        let system = try XCTUnwrap(messages.first?["content"]?.arrayValue)
        XCTAssertEqual(system.count, 1)
        XCTAssertEqual(system[0]["type"]?.stringValue, "text")
        XCTAssertEqual(system[0]["text"]?.stringValue, "You are a careful coding agent.")
        XCTAssertEqual(system[0]["cache_control"]?["type"]?.stringValue, "ephemeral")

        let newest = try XCTUnwrap(messages.last)
        XCTAssertEqual(newest["role"]?.stringValue, "tool")
        XCTAssertEqual(newest["tool_call_id"]?.stringValue, "call-1")
        let block = try XCTUnwrap(newest["content"]?.arrayValue?.last)
        XCTAssertEqual(block["text"]?.stringValue, "struct App {}")
        XCTAssertEqual(block["cache_control"]?["type"]?.stringValue, "ephemeral")

        let markers = messages.flatMap { $0["content"]?.arrayValue ?? [] }.filter { $0["cache_control"] != nil }
        XCTAssertEqual(markers.count, 2, "two of the four allowed markers")
        XCTAssertEqual(messages[1]["content"]?.stringValue, "Read the app file.", "unmarked messages stay as they were")
    }

    func testQwenMarkerSkipsAnAssistantMessageOfOnlyToolCalls() {
        var messages: [JSONValue] = [
            .object(["role": "system", "content": "s"]),
            .object(["role": "user", "content": .array([
                .object(["type": "image_url", "image_url": .object(["url": "data:x"])]),
                .object(["type": "text", "text": "look"]),
            ])]),
            .object(["role": "assistant", "content": .null, "tool_calls": .array([])]),
        ]
        PromptCacheWire.markQwen(&messages)
        XCTAssertNil(messages[2]["content"]?.arrayValue)
        let parts = messages[1]["content"]?.arrayValue ?? []
        XCTAssertNil(parts[0]["cache_control"])
        XCTAssertEqual(parts[1]["cache_control"]?["type"]?.stringValue, "ephemeral")
    }

    func testOnlyQwensExplicitCacheModelsAreMarked() {
        XCTAssertTrue(PromptCacheWire.usesQwenExplicitCache(providerID: "qwen", providerModelID: "qwen3.7-plus"))
        XCTAssertTrue(PromptCacheWire.usesQwenExplicitCache(providerID: "qwen", providerModelID: "qwen3.8-flash-2026-09"))
        XCTAssertFalse(PromptCacheWire.usesQwenExplicitCache(providerID: "qwen", providerModelID: "qwen3.6-plus"))
        XCTAssertFalse(PromptCacheWire.usesQwenExplicitCache(providerID: "openai", providerModelID: "qwen3.8-max"))
    }

    // MARK: Usage

    func testQwenCacheCreationIsAWrite() throws {
        var decoder = OpenAIChatStreamDecoder()
        let events = try decoder.events(from: Data(
            #"{"choices":[],"usage":{"prompt_tokens":5000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_input_tokens":4800}}}"#.utf8
        ))
        guard case .cacheUsage(readTokens: 0, writeTokens: 4_800)? = events.last else {
            return XCTFail("expected Qwen's cache creation as a write, got \(events)")
        }
    }
}

private extension Array {
    func shifted(by count: Int) -> [Element] {
        guard !isEmpty else { return self }
        let offset = count % self.count
        return Array(self[offset...] + self[..<offset])
    }
}
