import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// Flash and Pro are two switches that look alike and are not.
///
/// Flash is the provider's premium serving tier — `speed:"fast"` on Anthropic,
/// `service_tier:"priority"` on OpenAI — and it multiplies the whole bill for
/// the turn by 2 or 2.5. Pro is GPT-5.6's `reasoning.mode:"pro"`, which costs
/// the same per token and simply spends more of them.
///
/// What is tested here is the half a screenshot cannot show: that flipping a
/// switch changes the request, and that leaving it alone changes nothing. A
/// toggle that renders perfectly and sends nothing is the failure this file
/// exists to catch, and it is invisible from the outside — the answer still
/// arrives, just standard and at the standard price.
final class NativeFastAndProModeTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testTheRequestCarriesTheFastModeFlag() async throws {
        let body = try await sentBody(fastMode: true, proMode: false)
        XCTAssertEqual(body["fastMode"] as? Bool, true)
        XCTAssertNil(body["proMode"], "one switch must not arm the other")
    }

    func testTheRequestCarriesTheProModeFlag() async throws {
        let body = try await sentBody(fastMode: false, proMode: true)
        XCTAssertEqual(body["proMode"] as? Bool, true)
        XCTAssertNil(body["fastMode"])
    }

    func testBothTravelTogetherWhenBothAreOn() async throws {
        // They are independent axes, not a three-position switch: a turn can be
        // served fast AND reasoned hard.
        let body = try await sentBody(fastMode: true, proMode: true)
        XCTAssertEqual(body["fastMode"] as? Bool, true)
        XCTAssertEqual(body["proMode"] as? Bool, true)
    }

    /// Omitted rather than sent as `false`, so an ordinary turn's body is
    /// byte-identical to what it was before either mode existed. The chat
    /// route's schema is `.strict()` and both keys are optional there, so "off"
    /// is best said by saying nothing.
    func testAnOrdinaryTurnSendsNeitherKey() async throws {
        let body = try await sentBody(fastMode: false, proMode: false)
        XCTAssertNil(body["fastMode"])
        XCTAssertNil(body["proMode"])
    }

    /// Incognito honours both, because the server does. Leaving them off this
    /// branch would make the same toggle in the same composer bill differently
    /// depending on whether the chat happened to be private — a difference no
    /// one would think to look for.
    func testTheIncognitoRequestCarriesBothFlags() async throws {
        let streamer = ModeStreamer(responses: [streamResponse(minimalStream)])
        let client = NativeChatAPIClient(sender: ModeSender(), streamer: streamer)

        let stream = try await client.privateGenerationEvents(
            NativeChatPrivateGenerationRequest(
                modelID: "openai:gpt-5.6-sol",
                reasoningEffort: .low,
                generationID: "juno-native-generation-1",
                history: [NativeChatPrivateTurn(role: .user, content: "hello")],
                fastMode: true,
                proMode: true
            ),
            for: accountID
        )
        for try await _ in stream {}

        let object = try await firstBody(of: streamer)
        XCTAssertEqual(object["fastMode"] as? Bool, true)
        XCTAssertEqual(object["proMode"] as? Bool, true)
        XCTAssertEqual(object["privateMode"] as? Bool, true)
    }

    func testAnOrdinaryIncognitoTurnSendsNeitherKey() async throws {
        let streamer = ModeStreamer(responses: [streamResponse(minimalStream)])
        let client = NativeChatAPIClient(sender: ModeSender(), streamer: streamer)

        let stream = try await client.privateGenerationEvents(
            NativeChatPrivateGenerationRequest(
                modelID: "openai:gpt-5.6-sol",
                reasoningEffort: .low,
                generationID: "juno-native-generation-1",
                history: [NativeChatPrivateTurn(role: .user, content: "hello")]
            ),
            for: accountID
        )
        for try await _ in stream {}

        let object = try await firstBody(of: streamer)
        XCTAssertNil(object["fastMode"])
        XCTAssertNil(object["proMode"])
    }

    /// Pro composes with the thinking effort rather than replacing it — the
    /// whole reason it is a mode and not a rung on the ladder. A pro turn at
    /// Low must still say Low.
    func testProModeDoesNotDisturbTheReasoningEffort() async throws {
        let body = try await sentBody(fastMode: false, proMode: true, effort: .low)
        XCTAssertEqual(body["proMode"] as? Bool, true)
        XCTAssertEqual(body["reasoningEffort"] as? String, "low")
    }

    // MARK: - Harness

    private func sentBody(
        fastMode: Bool,
        proMode: Bool,
        effort: NativeReasoningEffort? = nil
    ) async throws -> [String: Any] {
        let streamer = ModeStreamer(responses: [streamResponse(minimalStream)])
        let client = NativeChatAPIClient(sender: ModeSender(), streamer: streamer)

        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5.6-sol",
                reasoningEffort: effort,
                generationID: "juno-native-generation-1",
                fastMode: fastMode,
                proMode: proMode
            ),
            for: accountID
        )
        for try await _ in stream {}

        return try await firstBody(of: streamer)
    }

    private func firstBody(of streamer: ModeStreamer) async throws -> [String: Any] {
        let requests = await streamer.requests
        let body = try XCTUnwrap(requests.first?.body)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private var minimalStream: String {
        """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hi","reasoning":null,"model":"openai:gpt-5.6-sol","createdAt":"2026-08-07T00:02:00.000Z","sources":[]},"artifacts":[],"memoryUpdated":false,"quota":{"plan":"FREE","used":1,"limit":10,"remaining":9},"finishReason":"stop"}


        """
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
                    for byte in data { continuation.yield(byte) }
                    continuation.finish()
                }
            }
        )
    }
}

private actor ModeSender: NativeAuthenticatedRequestSending {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data())
    }
}

private actor ModeStreamer: NativeAuthenticatedByteStreaming {
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
