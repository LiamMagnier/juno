import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

/// Both `/api/chat` grammars, from bytes to the answer on screen: recorded
/// and hand-built SSE bodies go through the real client (`generationEvents`,
/// its SSE parser and frame decoder) and then through the stream reducer
/// (``NativeTurnStream``) the store runs every turn through (Tool calls &
/// research SPEC §2, §2.13).
final class NativeTurnStreamTests: XCTestCase {
    private let account = try! AccountID("account-under-test")

    // MARK: Profile 1 (today's production)

    /// A recorded profile-1 turn: legacy rows, a provider search, the
    /// server's own `"\n\n"` between rounds, sources, and `done`. Everything
    /// is answer text, the rows are read by the legacy adapter, and the
    /// finished row is the `done` frame's.
    func testProfileOneTurnFromBytesToAnswer() async throws {
        let body = sse([
            #"{"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"Swift 6","generationId":"gen-00000001"}"#,
            #"{"type":"activity","event":{"id":"a1","kind":"context","title":"Reading the conversation context","detail":"3 messages","createdAt":"2026-09-23T10:00:00.000Z"}}"#,
            #"{"type":"activity","event":{"id":"a2","kind":"model","title":"Selected model","detail":"Anthropic · Claude Sonnet 4.6","createdAt":"2026-09-23T10:00:00.100Z"}}"#,
            #"{"type":"reasoning","text":"Check the adoption numbers."}"#,
            #"{"type":"activity","event":{"id":"a3","kind":"search","title":"Searching the web","detail":"swift 6 adoption","createdAt":"2026-09-23T10:00:02.000Z"}}"#,
            #"{"type":"activity","event":{"id":"a4","kind":"visit","title":"Visited source","url":"https://www.swift.org/blog/","createdAt":"2026-09-23T10:00:03.000Z"}}"#,
            #"{"type":"activity","event":{"id":"a5","kind":"write","title":"Writing the answer","createdAt":"2026-09-23T10:00:12.000Z"}}"#,
            #"{"type":"delta","text":"Let me look."}"#,
            #"{"type":"delta","text":"\n\n"}"#,
            #"{"type":"delta","text":"Most packages build in Swift 6 mode [1]."}"#,
            #"{"type":"sources","sources":[{"title":"Swift.org","url":"https://www.swift.org/blog/","snippet":"","cited":true}]}"#,
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"Most packages build in Swift 6 mode [1].","createdAt":"2026-09-23T10:00:19.000Z","sources":[{"title":"Swift.org","url":"https://www.swift.org/blog/","snippet":"","cited":true}]}}"#,
        ])
        let (events, request) = try await collect(body)

        var stream = NativeTurnStream()
        var outcome = NativeTurnStream.Outcome.continuing
        for event in events {
            // `.sequence` follows every frame: keep the terminal outcome.
            let result = stream.apply(event)
            if result != .continuing { outcome = result }
        }

        XCTAssertEqual(stream.grammar, .profile1)
        XCTAssertEqual(stream.answer, "Let me look.\n\nMost packages build in Swift 6 mode [1].")
        XCTAssertEqual(stream.reasoning, "Check the adoption numbers.")
        XCTAssertEqual(stream.sources.map(\.cited), [true])
        XCTAssertNil(stream.sources.first?.origin)
        guard case .completed(let message) = outcome else { return XCTFail("expected done") }
        XCTAssertEqual(message.content, "Most packages build in Swift 6 mode [1].")

        let view = NativeRunView.build(activity: stream.activity, reasoning: stream.reasoning, sources: stream.sources)
        XCTAssertFalse(view.typed)
        XCTAssertEqual(view.calls.map(\.tool), ["provider_web_search"])
        XCTAssertEqual(view.facts.model, "Anthropic · Claude Sonnet 4.6")
        XCTAssertEqual(view.timing.workedMs, 12_000)
        XCTAssertEqual(
            NativeToolPresentation.summaryLine(view, workedMs: view.timing.workedMs, sourceCount: 1).text,
            "Thought for 12s · 1 source"
        )

        // The request always declares the features, the zone and the locale.
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(object["clientFeatures"] as? [String], ["timeline", "resume", "research_background", "suggest_research", "citations"])
        XCTAssertEqual(object["timeZone"] as? String, TimeZone.current.identifier)
        XCTAssertNotNil(object["locale"] as? String)
        XCTAssertNil(object["researchEffort"], "Research has no levels (R1)")
    }

    // MARK: The timeline grammar

    /// A hand-built timeline turn: facts first, a reasoning segment, a round
    /// that talks before it searches (held, then commentary), the search's
    /// record re-sent in place as it runs and finishes, a round of answer,
    /// a notice, sources with their origin, and `done`.
    func testTimelineTurnKeepsCommentaryOutOfTheAnswer() async throws {
        let answer = "Adoption is broad. " + String(repeating: "Most of the top packages build cleanly. ", count: 8)
        let body = sse([
            #"{"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"Swift 6","generationId":"gen-00000001"}"#,
            #"{"type":"activity","event":{"id":"f1","kind":"model","title":"Selected model","seq":1,"createdAt":"2026-09-23T10:00:00.000Z","fact":{"key":"model","modelId":"anthropic:claude-sonnet-4-6","provider":"anthropic","label":"Claude Sonnet 4.6"}}}"#,
            #"{"type":"activity","event":{"id":"f2","kind":"context","title":"Tools ready","seq":2,"createdAt":"2026-09-23T10:00:00.010Z","fact":{"key":"tools","offered":["web_search","web_fetch"],"nativeSearch":false,"roundBudget":10}}}"#,
            #"{"type":"activity","event":{"id":"s1","kind":"reasoning","title":"Thinking","seq":3,"round":0,"createdAt":"2026-09-23T10:00:01.000Z","segment":{"round":0,"offset":0}}}"#,
            #"{"type":"reasoning","text":"**Checking adoption**","round":0}"#,
            #"{"type":"delta","text":"Let me look that up.","round":0}"#,
            #"{"type":"activity","event":{"id":"c1","kind":"search","title":"Searching the web","detail":"swift 6 adoption","seq":4,"round":0,"createdAt":"2026-09-23T10:00:02.000Z","call":{"v":1,"callId":"call_1","tool":"web_search","origin":"juno","title":"Web search","status":"queued","round":0,"index":0,"startedAt":"2026-09-23T10:00:02.000Z","args":{"query":"swift 6 adoption"}}}}"#,
            #"{"type":"activity","event":{"id":"c1","kind":"search","title":"Searching the web","detail":"swift 6 adoption","seq":4,"round":0,"createdAt":"2026-09-23T10:00:02.000Z","call":{"v":1,"callId":"call_1","tool":"web_search","origin":"juno","title":"Web search","status":"running","round":0,"index":0,"startedAt":"2026-09-23T10:00:02.000Z","timeoutMs":15000,"args":{"query":"swift 6 adoption"}}}}"#,
            #"{"type":"activity","event":{"id":"c1","kind":"search","title":"Searching the web","detail":"swift 6 adoption","seq":4,"round":0,"createdAt":"2026-09-23T10:00:02.000Z","call":{"v":1,"callId":"call_1","tool":"web_search","origin":"juno","title":"Web search","status":"succeeded","round":0,"index":0,"startedAt":"2026-09-23T10:00:02.000Z","endedAt":"2026-09-23T10:00:03.200Z","durationMs":1200,"args":{"query":"swift 6 adoption"},"figure":{"kind":"results","n":8},"web":{"query":"swift 6 adoption","engine":"tavily","results":[{"n":1,"title":"Ready for Swift 6","url":"https://swiftpackageindex.com/ready-for-swift-6"}]}}}}"#,
            #"{"type":"activity","event":{"id":"cm1","kind":"reasoning","title":"Commentary","detail":"Let me look that up.","seq":5,"round":0,"createdAt":"2026-09-23T10:00:03.300Z","commentary":{"round":0,"text":"Let me look that up.","inline":true}}}"#,
            #"{"type":"reasoning","text":"Enough to answer.","round":1}"#,
            #"{"type":"activity","event":{"id":"w1","kind":"write","title":"Writing the answer","seq":6,"round":1,"createdAt":"2026-09-23T10:00:05.000Z"}}"#,
            #"{"type":"delta","text":"\#(answer)","round":1}"#,
            #"{"type":"activity","event":{"id":"n1","kind":"context","title":"Search was limited","seq":7,"createdAt":"2026-09-23T10:00:06.000Z","notice":{"code":"search_degraded","params":{"engine":"brave"}}}}"#,
            #"{"type":"sources","sources":[{"title":"Ready for Swift 6","url":"https://swiftpackageindex.com/ready-for-swift-6","snippet":"","cited":true,"origin":"juno_search"},{"title":"Odd","url":"https://example.com/","snippet":"","origin":"not_an_origin"}]}"#,
            #"{"type":"activity","event":{"id":"d1","kind":"done","title":"Finished response","seq":8,"createdAt":"2026-09-23T10:00:09.000Z"}}"#,
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"\#(answer.trimmingCharacters(in: .whitespaces))","createdAt":"2026-09-23T10:00:09.000Z"}}"#,
        ])
        let (events, _) = try await collect(body)

        var stream = NativeTurnStream()
        var sawCommentaryInAnswer = false
        let start = Date(timeIntervalSince1970: 1_000)
        for (offset, event) in events.enumerated() {
            // Frames arrive 10ms apart: nothing is released by the clock.
            stream.apply(event, now: start.addingTimeInterval(Double(offset) * 0.01))
            if stream.answer.contains("Let me look that up.") { sawCommentaryInAnswer = true }
        }

        XCTAssertEqual(stream.grammar, .timeline)
        XCTAssertFalse(sawCommentaryInAnswer, "held text that became commentary never reached the answer")
        XCTAssertEqual(stream.answer, answer)
        XCTAssertTrue(stream.liveCommentary.isEmpty, "the server's commentary event took it over")
        XCTAssertEqual(stream.reasoning, "**Checking adoption**\n\nEnough to answer.")
        XCTAssertEqual(stream.sources.map(\.origin), ["juno_search", nil])
        // The record was re-sent three times under one id: one row.
        XCTAssertEqual(stream.activity.filter { $0.call != nil }.count, 1)

        let view = NativeRunView.build(activity: stream.activity, reasoning: stream.reasoning, sources: stream.sources)
        XCTAssertTrue(view.typed)
        XCTAssertEqual(view.items.map(\.id), ["s1", "c1", "cm1", "n1"])
        let call = try XCTUnwrap(view.calls.first)
        XCTAssertEqual(call.status, .succeeded)
        XCTAssertEqual(call.web?.engine, "tavily")
        XCTAssertEqual(call.web?.results.first?.n, 1)
        XCTAssertEqual(NativeToolPresentation.phrase(call), "Searched the web for \u{201C}swift 6 adoption\u{201D}")
        XCTAssertEqual(NativeToolPresentation.figure(call), "8 results")
        XCTAssertEqual(view.facts.model, "Claude Sonnet 4.6")
        XCTAssertEqual(view.facts.toolsOffered, ["web_search", "web_fetch"])
        XCTAssertEqual(view.inlineCommentary, ["Let me look that up."])
        guard case .notice(_, let notice, _, _)? = view.items.last else { return XCTFail("expected the notice") }
        XCTAssertEqual(notice?.code, "search_degraded")
        XCTAssertEqual(view.counts.warnings, 0, "an informational notice is not a warning")
        XCTAssertEqual(
            NativeToolPresentation.noticeLine(notice, title: "Search was limited", detail: nil).text,
            "Search was limited · brave"
        )
        XCTAssertEqual(NativeToolPresentation.summaryLine(view, workedMs: view.timing.workedMs, sourceCount: 2).text, "Thought for 5s · 2 sources")
    }

    /// With `phase` declared (OpenAI Responses), commentary goes straight to
    /// the commentary and the answer renders at once — no hold.
    func testDeclaredPhasesNeedNoHold() {
        var stream = NativeTurnStream()
        let now = Date(timeIntervalSince1970: 0)
        stream.apply(.activity(fact("tools", offered: ["web_search"])), now: now)
        stream.apply(.textDelta("I'll check the release notes.", round: 0, phase: .commentary), now: now)
        XCTAssertEqual(stream.answer, "")
        XCTAssertEqual(stream.liveCommentary, [NativeRunCommentary(round: 0, text: "I'll check the release notes.", inline: false)])
        XCTAssertFalse(stream.isHolding)
        stream.apply(.textDelta("Swift 6 shipped in 2024.", round: 1, phase: .answer), now: now)
        XCTAssertEqual(stream.answer, "Swift 6 shipped in 2024.")
        XCTAssertEqual(stream.answerStartedAt, now)
    }

    /// Undeclared text in a turn that offered tools is held: released at
    /// 600ms, at 280 characters, or at a paragraph break — and a turn that
    /// offered no tools never holds.
    func testTheProvisionalHold() {
        let now = Date(timeIntervalSince1970: 0)
        var held = NativeTurnStream()
        held.apply(.activity(fact("tools", offered: ["web_search"])), now: now)
        held.apply(.textDelta("Here is", round: 0), now: now)
        XCTAssertEqual(held.answer, "")
        XCTAssertEqual(held.holdDeadline, now.addingTimeInterval(0.6))
        held.releaseHeldText(now: now.addingTimeInterval(0.3))
        XCTAssertEqual(held.answer, "")
        held.releaseHeldText(now: now.addingTimeInterval(0.6))
        XCTAssertEqual(held.answer, "Here is")
        XCTAssertNil(held.holdDeadline)

        var paragraph = NativeTurnStream()
        paragraph.apply(.activity(fact("tools", offered: ["web_search"])), now: now)
        paragraph.apply(.textDelta("First.\n\nSecond.", round: 0), now: now)
        XCTAssertEqual(paragraph.answer, "First.\n\nSecond.")

        var untooled = NativeTurnStream()
        untooled.apply(.textDelta("Straight to it.", round: 0), now: now)
        XCTAssertEqual(untooled.answer, "Straight to it.")

        var ended = NativeTurnStream()
        ended.apply(.activity(fact("tools", offered: ["web_search"])), now: now)
        ended.apply(.textDelta("Short.", round: 0), now: now)
        ended.apply(.failed(message: "Stopped", finishReason: .userStopped, generationID: nil, userMessageID: nil), now: now)
        XCTAssertEqual(ended.answer, "Short.", "the end of the stream releases held text as answer")
    }

    /// A round the hold released as answer and the server later marks as
    /// commentary leaves the answer; rounds join with a blank line.
    func testLateCommentaryLeavesTheAnswer() {
        let now = Date(timeIntervalSince1970: 0)
        var stream = NativeTurnStream()
        stream.apply(.textDelta("Checking. ", round: 0), now: now)
        stream.apply(.textDelta("Found it.", round: 1), now: now)
        XCTAssertEqual(stream.answer, "Checking.\n\nFound it.")
        stream.apply(.activity(NativeChatActivity(
            id: "cm", kind: .reasoning, title: "Commentary", detail: nil, url: nil, seq: 3,
            commentary: NativeRunCommentary(round: 0, text: "Checking.", inline: true)
        )), now: now)
        XCTAssertEqual(stream.answer, "Found it.")
    }

    /// The handoff frame ends the stream: no `done` follows, and the client
    /// follows the run instead.
    func testHandoffIsTerminal() async throws {
        let body = sse([
            #"{"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"Research","generationId":"gen-00000001"}"#,
            #"{"type":"handoff","to":"research","runId":"run_abc","userMessageId":"msg-q"}"#,
        ])
        let (events, _) = try await collect(body)
        var stream = NativeTurnStream()
        var outcome = NativeTurnStream.Outcome.continuing
        for event in events {
            // `.sequence` follows every frame: keep the terminal outcome.
            let result = stream.apply(event)
            if result != .continuing { outcome = result }
        }
        XCTAssertEqual(outcome, .handoff(NativeResearchHandoff(runID: "run_abc", userMessageID: "msg-q")))
        XCTAssertEqual(stream.answer, "")
    }

    /// Unknown statuses read as running, unknown error codes as a generic
    /// failure, unknown phases as undeclared, unknown frames are skipped.
    func testUnknownValuesDegradeRatherThanFail() async throws {
        let body = sse([
            #"{"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"T","generationId":"gen-00000001"}"#,
            #"{"type":"brand_new_frame","payload":{"x":1}}"#,
            #"{"type":"activity","event":{"id":"c1","kind":"tool","title":"Using Thing","seq":1,"call":{"v":2,"callId":"k1","tool":"run_code","status":"teleporting","round":0}}}"#,
            #"{"type":"activity","event":{"id":"c2","kind":"tool","title":"Using Thing","seq":2,"call":{"callId":"k2","tool":"web_fetch","status":"failed","round":0,"error":{"code":"quantum","detail":"HTTP 418"},"args":{"url":"https://www.example.org/a","domain":"example.org"}}}}"#,
            #"{"type":"delta","text":"Hi","round":0,"phase":"musing"}"#,
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"Hi","createdAt":"2026-09-23T10:00:09.000Z"}}"#,
        ])
        let (events, _) = try await collect(body)
        var stream = NativeTurnStream()
        for event in events { stream.apply(event) }
        let calls = NativeRunView.build(activity: stream.activity, reasoning: nil).calls
        XCTAssertEqual(calls.map(\.status), [.running, .failed])
        XCTAssertEqual(calls.last?.errorCode, "tool_error")
        XCTAssertEqual(calls.last?.errorDetail, "HTTP 418")
        XCTAssertEqual(NativeToolPresentation.phrase(calls[1]), "Couldn't open example.org")
        XCTAssertEqual(stream.answer, "Hi")
    }

    /// Reasoning parts and rounds put a blank line at the boundary the
    /// provider declared — the web's `appendReasoningDelta` — so segment
    /// offsets index the same string the server's do.
    func testReasoningBoundaries() {
        var stream = NativeTurnStream()
        stream.apply(.reasoningDelta("**Plan**", part: 0, round: 0))
        stream.apply(.reasoningDelta(" more", part: 0, round: 0))
        stream.apply(.reasoningDelta("**Next**", part: 1, round: 0))
        stream.apply(.reasoningDelta("Then.", part: nil, round: 1))
        XCTAssertEqual(stream.reasoning, "**Plan** more\n\n**Next**\n\nThen.")
        XCTAssertEqual(stream.reasoningParts, ["**Plan** more", "**Next**"])
    }

    // MARK: Helpers

    private func fact(_ key: String, offered: [String]) -> NativeChatActivity {
        NativeChatActivity(
            id: "fact-\(key)", kind: .context, title: "Tools ready", detail: nil, url: nil, seq: 1,
            fact: .tools(offered: offered, nativeSearch: false, roundBudget: 10)
        )
    }

    private func sse(_ frames: [String]) -> String {
        frames.enumerated().map { "id: \($0.offset + 1)\ndata: \($0.element)\n\n" }.joined()
    }

    /// Streams `body` through the real client, returning its events and the
    /// request it sent.
    private func collect(_ body: String) async throws -> ([NativeChatServerEvent], NativeBearerRequest) {
        let streamer = TurnStreamer(body: body)
        let client = NativeChatAPIClient(sender: TurnSender(), streamer: streamer)
        let events = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "anthropic:claude-sonnet-4-6",
                reasoningEffort: nil,
                generationID: "gen-00000001",
                deepResearch: true
            ),
            for: account
        )
        var collected: [NativeChatServerEvent] = []
        for try await event in events { collected.append(event) }
        let request = try await XCTUnwrapAsync(await streamer.request)
        return (collected, request)
    }
}

private func XCTUnwrapAsync<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) async throws -> T {
    try XCTUnwrap(value, file: file, line: line)
}

private struct TurnSender: NativeAuthenticatedRequestSending {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        HTTPResponse(statusCode: 404, headers: HTTPHeaders(), body: Data())
    }
}

private actor TurnStreamer: NativeAuthenticatedByteStreaming {
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
