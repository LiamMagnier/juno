import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// Deep research on the server is a flag on the chat turn with a
/// PLAN → SEARCH → READ → SYNTHESIS pipeline behind it, streaming activity
/// steps and a sources chunk through the ordinary chat stream. Parity is
/// therefore sending that flag and rendering what comes back — not
/// reimplementing the pipeline, and not dressing up an ordinary prompt.
final class NativeDeepResearchTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    /// The switch itself. Without it on the wire the server runs a plain turn
    /// and the reader gets an unresearched answer that looks identical.
    func testTheRequestCarriesTheDeepResearchFlag() async throws {
        let streamer = DeepResearchStreamer(responses: [streamResponse(minimalStream)])
        let client = NativeChatAPIClient(sender: DeepResearchSender(), streamer: streamer)

        _ = try await drain(client, streamer: streamer, deepResearch: true)

        let requests = await streamer.requests
        let body = try XCTUnwrap(requests.first?.body)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(object["deepResearch"] as? Bool, true)
    }

    /// Omitted rather than sent as `false`, so an ordinary turn's body stays
    /// byte-identical to what it was before research existed.
    func testAnOrdinaryTurnSendsNoResearchKey() async throws {
        let streamer = DeepResearchStreamer(responses: [streamResponse(minimalStream)])
        let client = NativeChatAPIClient(sender: DeepResearchSender(), streamer: streamer)

        _ = try await drain(client, streamer: streamer, deepResearch: false)

        let requests = await streamer.requests
        let body = try XCTUnwrap(requests.first?.body)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertNil(object["deepResearch"])
    }

    /// The steps that fill the tens of seconds before the report starts
    /// streaming. These used to be discarded as pings, which is exactly why the
    /// screen showed nothing but a spinner through the whole prep phase.
    func testActivityStepsAreParsedRatherThanDiscarded() async throws {
        let body = """
        data: {"type":"activity","event":{"id":"a1","kind":"search","title":"Searching the web","detail":"swift concurrency","createdAt":"2026-07-22T10:00:00.000Z"}}

        data: {"type":"activity","event":{"id":"a2","kind":"visit","title":"Reading","url":"https://example.com","createdAt":"2026-07-22T10:00:01.000Z"}}

        data: {"type":"activity","event":{"id":"a3","kind":"quantum-telepathy","title":"Something new","createdAt":"2026-07-22T10:00:02.000Z"}}

        data: {"type":"activity","event":{"nonsense":true}}

        \(doneFrame)

        """
        let streamer = DeepResearchStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: DeepResearchSender(), streamer: streamer)

        let events = try await drain(client, streamer: streamer, deepResearch: true)
        let activities: [NativeChatActivity] = events.compactMap {
            if case .activity(let activity) = $0 { return activity }
            return nil
        }

        XCTAssertEqual(activities.count, 3, "three well-formed steps, the fourth is unreadable")
        XCTAssertEqual(activities[0].kind, .search)
        XCTAssertEqual(activities[0].detail, "swift concurrency")
        XCTAssertEqual(activities[1].kind, .visit)
        XCTAssertEqual(activities[1].url, "https://example.com")

        // A server that adds a kind must not make the step vanish from screen.
        XCTAssertEqual(activities[2].kind, .unknown)
        XCTAssertEqual(activities[2].title, "Something new")

        // And an unreadable payload must not fail the stream: the report itself
        // is unaffected by it.
        XCTAssertTrue(events.contains(.ping))
        XCTAssertTrue(events.contains { if case .completed = $0 { return true }; return false })
    }

    func testEveryDocumentedActivityKindDecodes() async throws {
        let kinds = [
            "context", "model", "reasoning", "search", "visit",
            "write", "usage", "done", "warning", "tool",
        ]
        let frames = kinds.enumerated().map { index, kind in
            "data: {\"type\":\"activity\",\"event\":{\"id\":\"a\(index)\",\"kind\":\"\(kind)\",\"title\":\"t\",\"createdAt\":\"2026-07-22T10:00:00.000Z\"}}\n"
        }.joined(separator: "\n")

        let streamer = DeepResearchStreamer(
            responses: [streamResponse(frames + "\n" + doneFrame + "\n\n")]
        )
        let client = NativeChatAPIClient(sender: DeepResearchSender(), streamer: streamer)
        let events = try await drain(client, streamer: streamer, deepResearch: true)

        let decoded: [NativeChatActivity] = events.compactMap {
            if case .activity(let activity) = $0 { return activity }
            return nil
        }
        XCTAssertEqual(decoded.count, kinds.count)
        XCTAssertFalse(
            decoded.contains { $0.kind == .unknown },
            "Every kind the server documents must decode to a known case."
        )
    }

    // MARK: - Helpers

    private var minimalStream: String { doneFrame + "\n\n" }

    private var doneFrame: String {
        """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Report","reasoning":null,"model":"openai:gpt-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[]},"artifacts":[],"memoryUpdated":false,"quota":{"plan":"FREE","used":1,"limit":10,"remaining":9},"finishReason":"stop"}
        """
    }

    private func drain(
        _ client: NativeChatAPIClient,
        streamer: DeepResearchStreamer,
        deepResearch: Bool
    ) async throws -> [NativeChatServerEvent] {
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: nil,
                generationID: "juno-native-generation-1",
                deepResearch: deepResearch
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }
        return events
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

private actor DeepResearchSender: NativeAuthenticatedRequestSending {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data())
    }
}

private actor DeepResearchStreamer: NativeAuthenticatedByteStreaming {
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
