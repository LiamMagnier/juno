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
