import XCTest
import JunoAPI
import JunoAuth
import JunoCodeCore
import JunoCodeRuntime
import JunoCore
import JunoSync
@testable import JunoCodeBridge

/// What a failed response or a stream's ending tells the agent loop: typed
/// errors carrying the provider's own `retry-after`, and a stop reason for
/// each ending that is not a finished answer.
final class ProviderFailureClassificationTests: XCTestCase {
    private func classify(
        _ status: Int,
        _ message: String,
        type: String? = nil,
        headers: [String: String] = [:]
    ) throws -> AgentModelClientError {
        BackendCodeModelClient.classify(
            status: status,
            headers: try HTTPHeaders(headers),
            failure: .init(message: message, code: nil, providerType: type)
        )
    }

    func testRateLimitsCarryTheProvidersRetryAfter() throws {
        XCTAssertEqual(
            try classify(429, "Too many requests", headers: ["Retry-After": "7"]),
            .rateLimited(retryAfter: 7)
        )
        XCTAssertEqual(
            try classify(429, "Too many requests", headers: ["retry-after-ms": "1500", "retry-after": "9"]),
            .rateLimited(retryAfter: 1.5),
            "the exact millisecond header wins"
        )
        XCTAssertEqual(try classify(429, "slow down"), .rateLimited(retryAfter: nil))
    }

    func testAnHTTPDateRetryAfterIsTheTimeUntilThen() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        let header = formatter.string(from: now.addingTimeInterval(12))
        let seconds = BackendCodeModelClient.retryAfterSeconds(try HTTPHeaders(["Retry-After": header]), now: now)
        XCTAssertEqual(try XCTUnwrap(seconds), 12, accuracy: 1)
    }

    func testOverloadIsItsOwnKind() throws {
        XCTAssertEqual(try classify(529, "Overloaded", type: "overloaded_error"), .overloaded(retryAfter: nil))
        XCTAssertEqual(try classify(503, "Service unavailable", headers: ["retry-after": "2"]), .overloaded(retryAfter: 2))
    }

    func testTooLongForTheWindowIsRecognisedInEachLabsWords() throws {
        XCTAssertEqual(
            try classify(400, "prompt is too long: 215000 tokens > 200000 maximum", type: "invalid_request_error"),
            .contextWindowExceeded(message: "prompt is too long: 215000 tokens > 200000 maximum")
        )
        XCTAssertEqual(
            try classify(400, "This model's maximum context length is 128000 tokens.", type: "context_length_exceeded"),
            .contextWindowExceeded(message: "This model's maximum context length is 128000 tokens.")
        )
        XCTAssertEqual(try classify(413, "Request too large"), .contextWindowExceeded(message: "Request too large"))
    }

    /// A request the provider refuses outright is never retried: sent again
    /// it fails the same way. Only a timeout, a conflict or a 5xx is.
    func testARefusedRequestIsRejectedNotATransportFailure() throws {
        XCTAssertEqual(
            try classify(400, "thinking.budget_tokens: Input should be less than max_tokens", type: "invalid_request_error"),
            .rejected(message: "thinking.budget_tokens: Input should be less than max_tokens")
        )
        XCTAssertEqual(try classify(404, "model: not-a-model"), .rejected(message: "model: not-a-model"))
        XCTAssertEqual(try classify(422, "Unprocessable"), .rejected(message: "Unprocessable"))
        XCTAssertEqual(try classify(408, "Request timeout"), .transport(message: "Request timeout"))
        XCTAssertEqual(
            try classify(502, "Upstream provider request failed."),
            .transport(message: "Upstream provider request failed.")
        )
    }

    /// A 429 is a limit to wait out whatever words come with it; only a
    /// shortage of credit outranks the status.
    func testA429IsARateLimitEvenWhenItsWordsSoundLikeAnOverflow() throws {
        XCTAssertEqual(
            try classify(429, "Too many tokens per minute for this context window", headers: ["retry-after": "4"]),
            .rateLimited(retryAfter: 4)
        )
        XCTAssertEqual(
            try classify(429, "You exceeded your current quota, please check your plan and billing details."),
            .quotaExhausted(message: "You exceeded your current quota, please check your plan and billing details.")
        )
    }

    func testCreditAndCredentialsStayWhatTheyWere() throws {
        XCTAssertEqual(try classify(401, "bad key"), .unauthorized)
        XCTAssertEqual(
            try classify(400, "Your credit balance is too low to access the Anthropic API"),
            .quotaExhausted(message: "Your credit balance is too low to access the Anthropic API")
        )
        XCTAssertEqual(try classify(500, "Internal error"), .transport(message: "Internal error"))
    }

    func testAnOverloadInsideTheStreamIsTypedToo() throws {
        var decoder = AnthropicStreamDecoder()
        let payload = Data(#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#.utf8)
        XCTAssertThrowsError(try decoder.events(from: payload)) { error in
            XCTAssertEqual(error as? AgentModelClientError, .overloaded(retryAfter: nil))
        }
    }

    func testAnthropicStopReasonsTheLoopMustActOnAreKeptApart() {
        XCTAssertEqual(AnthropicStreamDecoder.mapStopReason("refusal"), .refusal)
        XCTAssertEqual(AnthropicStreamDecoder.mapStopReason("pause_turn"), .pauseTurn)
        XCTAssertEqual(AnthropicStreamDecoder.mapStopReason("model_context_window_exceeded"), .contextWindowExceeded)
        XCTAssertEqual(AnthropicStreamDecoder.mapStopReason("max_tokens"), .maxTokens)
        XCTAssertEqual(AnthropicStreamDecoder.mapStopReason("stop_sequence"), .endTurn)
    }

    func testARefusalReachesTheLoopAsARefusal() throws {
        var decoder = AnthropicStreamDecoder()
        _ = try decoder.events(from: Data(#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#.utf8))
        let events = try decoder.events(from: Data(#"{"type":"message_stop"}"#.utf8))
        guard case .turnCompleted(.refusal)? = events.last else {
            return XCTFail("expected a refusal, got \(events)")
        }
    }

    func testAChatContentFilterIsARefusal() throws {
        var decoder = OpenAIChatStreamDecoder()
        let events = try decoder.events(
            from: Data(#"{"choices":[{"delta":{"content":"I can"},"finish_reason":"content_filter"}]}"#.utf8)
        )
        guard case .turnCompleted(.refusal)? = events.last else {
            return XCTFail("expected a refusal, got \(events)")
        }
    }

    // MARK: - Malformed tool arguments

    func testTruncatedAnthropicToolArgumentsBecomeAMalformedCallNotAnEmptyOne() throws {
        var decoder = AnthropicStreamDecoder()
        _ = try decoder.events(from: Data(
            #"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"write_file","input":{}}}"#.utf8
        ))
        _ = try decoder.events(from: Data(
            #"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\": \"a.swift\", \"content\": \"let"}}"#.utf8
        ))
        let events = try decoder.events(from: Data(#"{"type":"content_block_stop","index":0}"#.utf8))
        guard case let .toolCallMalformed(id, name, raw, error, extra)? = events.first else {
            return XCTFail("expected a malformed call, got \(events)")
        }
        XCTAssertEqual(id, "t1")
        XCTAssertEqual(name, "write_file")
        XCTAssertEqual(raw, #"{"path": "a.swift", "content": "let"#)
        XCTAssertFalse(error.isEmpty)
        XCTAssertNil(extra)
    }

    func testAToolWithNoParametersStillStreamsAsAnEmptyObject() throws {
        var decoder = AnthropicStreamDecoder()
        _ = try decoder.events(from: Data(
            #"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t2","name":"git_status","input":{}}}"#.utf8
        ))
        let events = try decoder.events(from: Data(#"{"type":"content_block_stop","index":0}"#.utf8))
        guard case let .toolCallRequested(_, _, input)? = events.first else {
            return XCTFail("expected a call, got \(events)")
        }
        XCTAssertEqual(input, [:])
    }

    func testMalformedChatArgumentsKeepTheCallsThoughtSignature() throws {
        var decoder = OpenAIChatStreamDecoder()
        let chunk = #"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"g1","function":{"name":"grep","arguments":"{\"pattern\": "},"extra_content":{"google":{"thought_signature":"sig"}}}]},"finish_reason":"tool_calls"}]}"#
        let events = try decoder.events(from: Data(chunk.utf8))
        guard case let .toolCallMalformed(id, _, _, _, extra)? = events.first else {
            return XCTFail("expected a malformed call, got \(events)")
        }
        XCTAssertEqual(id, "g1")
        XCTAssertEqual(extra?["google"]?["thought_signature"]?.stringValue, "sig")
        guard case .turnCompleted(.toolUse)? = events.last else {
            return XCTFail("the turn still ends as a tool turn")
        }
    }

    func testTheClientSaysWhichProvidersCacheAPrefix() throws {
        let client = BackendCodeModelClient(
            streamer: NeverStreamer(),
            accountID: try AccountID("account-1")
        )
        XCTAssertTrue(client.cachesPromptPrefix(for: "anthropic:claude-opus-5-5"))
        XCTAssertTrue(client.cachesPromptPrefix(for: "openai:gpt-6"))
        XCTAssertFalse(client.cachesPromptPrefix(for: "deepseek:deepseek-v4"))
    }
}

private struct NeverStreamer: NativeAuthenticatedByteStreaming {
    func stream(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPByteStreamResponse {
        throw URLError(.notConnectedToInternet)
    }
}
