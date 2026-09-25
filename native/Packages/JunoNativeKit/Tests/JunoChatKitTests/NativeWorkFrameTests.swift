import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

/// A task the model starts (Phase 5 brief A1): the client says it can draw one
/// (`workHandoff`), and reads the `work` frame the stream sends when the model
/// started one — in the web's `serializeSession` shape.
final class NativeWorkFrameTests: XCTestCase {
    private let account = try! AccountID("account-under-test")

    /// Recorded from a model-started task (`route.ts` `onStarted`): the frame
    /// arrives mid-reply, and the reply goes on around it.
    func testAWorkFrameDecodesIntoTheSessionItStarted() async throws {
        let body = sse([
            #"{"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"Vendor quotes","generationId":"gen-00000001"}"#,
            #"{"type":"activity","event":{"id":"a1","kind":"context","title":"Starting a task","detail":"Compare the three vendor quotes","createdAt":"2026-09-24T17:58:01.500Z"}}"#,
            Self.workFrame,
            #"{"type":"delta","text":"I’ve started a task to compare them."}"#,
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"I’ve started a task to compare them.","createdAt":"2026-09-24T17:58:03.000Z"}}"#,
        ])
        let (events, _) = try await collect(body)

        let starts = events.compactMap { event -> NativeChatWorkStart? in
            if case .work(let start) = event { return start }
            return nil
        }
        XCTAssertEqual(starts.count, 1)
        let start = try XCTUnwrap(starts.first)
        XCTAssertEqual(start.sessionID, "wsi_3f9a0c1e5b7d")
        XCTAssertEqual(start.conversationID, "conv_12345678")
        XCTAssertEqual(start.title, "Compare the three vendor quotes")
        XCTAssertEqual(start.status, "queued")
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertEqual(start.createdAt, formatter.date(from: "2026-09-24T17:58:01.902Z"))
        // The session's own JSON rides along for the Work side to decode.
        let session = try XCTUnwrap(JSONSerialization.jsonObject(with: start.sessionJSON) as? [String: Any])
        XCTAssertEqual(session["permissionPolicy"] as? String, "balanced")
        // Not terminal: the reply finished after it.
        XCTAssertTrue(events.contains { if case .completed = $0 { true } else { false } })
    }

    /// A frame this build does not describe is still skipped, and a `work`
    /// frame it cannot read is skipped rather than failing the reply.
    func testUnknownAndUnreadableFramesAreSkipped() async throws {
        let body = sse([
            #"{"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"","generationId":"gen-00000001"}"#,
            #"{"type":"something_new","session":{"id":7}}"#,
            #"{"type":"work","session":{"title":"No id"}}"#,
            #"{"type":"delta","text":"Hi"}"#,
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"Hi","createdAt":"2026-09-24T17:58:03.000Z"}}"#,
        ])
        let (events, _) = try await collect(body)
        XCTAssertFalse(events.contains { if case .work = $0 { true } else { false } })
        XCTAssertTrue(events.contains { if case .completed = $0 { true } else { false } })
    }

    /// A saved chat on an app that draws the card says so; nothing else does.
    func testTheFlagTravelsOnlyWhenClaimed() async throws {
        let claimed = try await sentBody(workHandoff: true)
        XCTAssertEqual(claimed["workHandoff"] as? Bool, true)

        let unclaimed = try await sentBody(workHandoff: false)
        XCTAssertNil(unclaimed["workHandoff"], "false is said by saying nothing")
    }

    /// The composer's armed skill travels as `skillSlug`; with none armed the
    /// key is absent (integration: Phase 4 B's library on the wire).
    func testTheArmedSkillTravelsAsSkillSlug() async throws {
        let armed = try await sentBody(workHandoff: false, skillSlug: "tidy-inbox")
        XCTAssertEqual(armed["skillSlug"] as? String, "tidy-inbox")

        let none = try await sentBody(workHandoff: false)
        XCTAssertNil(none["skillSlug"])
    }

    /// A private turn persists nothing a task could hang off: its body has no
    /// such key at all.
    func testThePrivateBodyNeverCarriesTheFlag() async throws {
        let streamer = FrameStreamer(body: sse([
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"Hi","createdAt":"2026-09-24T17:58:03.000Z"}}"#,
        ]))
        let client = NativeChatAPIClient(sender: FrameSender(), streamer: streamer)
        let events = try await client.privateGenerationEvents(
            NativeChatPrivateGenerationRequest(
                modelID: "anthropic:claude-sonnet-4-6",
                reasoningEffort: nil,
                generationID: "gen-00000002",
                history: [NativeChatPrivateTurn(role: .user, content: "Hello")]
            ),
            for: account
        )
        for try await _ in events {}
        let captured = await streamer.request
        let request = try XCTUnwrap(captured)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertNil(object["workHandoff"])
        XCTAssertEqual(object["privateMode"] as? Bool, true)
    }

    // MARK: - Harness

    static let workFrame = #"{"type":"work","session":{"id":"wsi_3f9a0c1e5b7d","projectId":null,"conversationId":"conv_12345678","title":"Compare the three vendor quotes","titleSource":"model","goal":"Compare the three vendor quotes on price, lead time and support terms, and recommend one.","status":"queued","needsAttention":false,"requestedTarget":"automatic","preferredHostId":null,"requestedModel":"anthropic:claude-sonnet-4-6","reasoningEffort":null,"permissionPolicy":"balanced","pinned":false,"archived":false,"lastActivityAt":"2026-09-24T17:58:02.114Z","createdAt":"2026-09-24T17:58:01.902Z","updatedAt":"2026-09-24T17:58:02.114Z"}}"#

    private func sse(_ frames: [String]) -> String {
        frames.enumerated().map { "id: \($0.offset + 1)\ndata: \($0.element)\n\n" }.joined()
    }

    private func collect(_ body: String) async throws -> ([NativeChatServerEvent], NativeBearerRequest) {
        let streamer = FrameStreamer(body: body)
        let client = NativeChatAPIClient(sender: FrameSender(), streamer: streamer)
        let events = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "anthropic:claude-sonnet-4-6",
                reasoningEffort: nil,
                generationID: "gen-00000001",
                workHandoff: true
            ),
            for: account
        )
        var collected: [NativeChatServerEvent] = []
        for try await event in events { collected.append(event) }
        let captured = await streamer.request
        let request = try XCTUnwrap(captured)
        return (collected, request)
    }

    private func sentBody(workHandoff: Bool, skillSlug: String? = nil) async throws -> [String: Any] {
        let streamer = FrameStreamer(body: sse([
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"Hi","createdAt":"2026-09-24T17:58:03.000Z"}}"#,
        ]))
        let client = NativeChatAPIClient(sender: FrameSender(), streamer: streamer)
        let events = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "anthropic:claude-sonnet-4-6",
                reasoningEffort: nil,
                generationID: "gen-00000003",
                workHandoff: workHandoff,
                skillSlug: skillSlug
            ),
            for: account
        )
        for try await _ in events {}
        let captured = await streamer.request
        let request = try XCTUnwrap(captured)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: Any])
    }
}

private struct FrameSender: NativeAuthenticatedRequestSending {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        HTTPResponse(statusCode: 404, headers: HTTPHeaders(), body: Data())
    }
}

private actor FrameStreamer: NativeAuthenticatedByteStreaming {
    private let body: String
    private(set) var request: NativeBearerRequest?

    init(body: String) { self.body = body }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        self.request = request
        let data = Data(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                for byte in data { continuation.yield(byte) }
                continuation.finish()
            }
        )
    }
}
