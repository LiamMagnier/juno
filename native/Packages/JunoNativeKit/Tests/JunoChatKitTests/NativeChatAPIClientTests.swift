import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeChatAPIClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testCatalogAndIdempotentUserAppendUseExistingBearerRoutes() async throws {
        let sender = ChatQueueSender(responses: [
            response(#"{"manifestVersion":"v1-catalog","contractDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generatedAt":"2026-07-22T00:00:00.000Z","models":[{"id":"openai:gpt-5","provider":{"id":"openai","displayName":"OpenAI"},"displayName":"GPT-5","availability":"available","minimumPlan":"free","supportedReasoningEfforts":["low","high"],"reasoning":{"canDisable":true},"capabilities":{"streaming":true}}]}"#),
            response(#"{"conversationId":"conv_12345678","messages":[{"clientId":"client-12345678","id":"msg_12345678","role":"USER","content":"Hello Juno","createdAt":"2026-07-22T00:01:00.000Z","created":true}]}"#),
        ])
        let client = NativeChatAPIClient(sender: sender, streamer: EmptyChatStreamer())

        let catalog = try await client.modelCatalog(for: accountID)
        let appended = try await client.appendUserMessage(
            conversationID: "conv_12345678",
            clientID: "client-12345678",
            content: "  Hello Juno  ",
            for: accountID
        )

        XCTAssertEqual(catalog.models.map(\.id), ["openai:gpt-5"])
        XCTAssertEqual(catalog.models.first?.supportedReasoningEfforts, [.low, .high])
        XCTAssertEqual(appended.id, "msg_12345678")
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), [
            "/api/v1/models",
            "/api/conversations/conv_12345678/messages",
        ])
        XCTAssertEqual(requests.last?.method, .post)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(requests.last?.body))
                as? [String: Any]
        )
        let turns = try XCTUnwrap(object["turns"] as? [[String: Any]])
        XCTAssertEqual(turns.first?["clientId"] as? String, "client-12345678")
        XCTAssertEqual(turns.first?["content"] as? String, "Hello Juno")
    }

    func testRealSSEFramesDecodeProgressivelyAndGenerationRequestDoesNotReappend() async throws {
        let body = """
        data: {"type":"meta","conversationId":"conv_12345678","userMessageId":null,"title":"A real chat","generationId":"juno-native-generation-1"}

        data: {"type":"reasoning","text":"Checking"}

        data: {"type":"delta","text":"Hello "}

        data: {"type":"delta","text":"there"}

        data: {"type":"sources","sources":[{"title":"Juno","url":"https://chat.liams.dev/docs","snippet":"Docs"}]}

        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hello there","reasoning":"Checking","model":"openai:gpt-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[]},"artifacts":[],"memoryUpdated":false,"quota":{"plan":"FREE","used":1,"limit":10,"remaining":9},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: .high,
                generationID: "juno-native-generation-1"
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }

        XCTAssertEqual(events.count, 6)
        XCTAssertEqual(events[1], .reasoningDelta("Checking"))
        XCTAssertEqual(events[2], .textDelta("Hello "))
        XCTAssertEqual(events[3], .textDelta("there"))
        guard case .completed(let completed) = events.last else {
            return XCTFail("Expected the authoritative done frame")
        }
        XCTAssertEqual(completed.id, "assistant_12345678")
        XCTAssertEqual(completed.content, "Hello there")
        XCTAssertEqual(completed.finishReason, .stop)

        let streamedRequests = await streamer.requests
        let request = try XCTUnwrap(streamedRequests.first)
        XCTAssertEqual(request.path, "/api/chat")
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.body))
                as? [String: Any]
        )
        XCTAssertEqual(object["conversationId"] as? String, "conv_12345678")
        XCTAssertEqual(object["regenerate"] as? Bool, true)
        XCTAssertNil(object["message"])
        XCTAssertEqual(object["client"] as? String, "app")
        XCTAssertEqual(object["reasoningEffort"] as? String, "high")
    }

    /// The prompt-cache split rides the live `done` frame — the server reads it
    /// off the in-flight accumulator, because `Message` has no column for it.
    func testDoneFrameCarriesThePromptCacheSplit() async throws {
        let body = """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hi","reasoning":null,"model":"anthropic:claude-opus-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[],"promptTokens":12000,"completionTokens":300,"costUsd":0.0182,"cacheReadTokens":9600,"cacheWriteTokens":1400},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "anthropic:claude-opus-5",
                reasoningEffort: .high,
                generationID: "juno-native-generation-1"
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }

        guard case .completed(let completed) = events.last else {
            return XCTFail("Expected the authoritative done frame")
        }
        XCTAssertEqual(completed.promptTokens, 12_000)
        XCTAssertEqual(completed.cacheReadTokens, 9_600)
        XCTAssertEqual(completed.cacheWriteTokens, 1_400)
        XCTAssertEqual(try XCTUnwrap(completed.cacheHitRate), 0.8, accuracy: 1e-9)
    }

    /// A persisted message re-read after a sync has no cache columns. Absent has
    /// to stay absent: rendering it as 0 would report a cache miss that never
    /// happened, and every older server sends exactly this shape.
    func testADoneFrameWithoutCacheFieldsLeavesThemUnknown() async throws {
        let body = """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hi","reasoning":null,"model":"openai:gpt-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[],"promptTokens":900,"completionTokens":100},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: .high,
                generationID: "juno-native-generation-1"
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }

        guard case .completed(let completed) = events.last else {
            return XCTFail("Expected the authoritative done frame")
        }
        XCTAssertEqual(completed.promptTokens, 900)
        XCTAssertNil(completed.cacheReadTokens)
        XCTAssertNil(completed.cacheWriteTokens)
        XCTAssertNil(completed.cacheHitRate)
    }

    func testStreamWithoutTerminalFrameRequiresSyncRecoveryInsteadOfRepost() async throws {
        let streamer = ChatQueueStreamer(responses: [streamResponse(
            "data: {\"type\":\"delta\",\"text\":\"Partial\"}\n\n"
        )])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: nil,
                generationID: "juno-native-generation-2"
            ),
            for: accountID
        )
        do {
            for try await _ in stream {}
            XCTFail("A dropped SSE must enter recovery")
        } catch {
            XCTAssertEqual(
                error as? NativeChatAPIError,
                .streamEndedWithoutTerminalEvent
            )
        }
        let requestCount = await streamer.requests.count
        XCTAssertEqual(requestCount, 1)
    }

    func testV1ErrorEnvelopeKeepsCodeMessageAndRetryability() async throws {
        let sender = ChatQueueSender(responses: [response(
            #"{"error":{"code":"server_unavailable","message":"Catalog is warming up.","requestId":"req-1","retryable":true,"retryAfterMs":250}}"#,
            statusCode: 503
        )])
        let client = NativeChatAPIClient(sender: sender, streamer: EmptyChatStreamer())

        do {
            _ = try await client.modelCatalog(for: accountID)
            XCTFail("Expected the typed server failure")
        } catch {
            XCTAssertEqual(
                error as? NativeChatAPIError,
                .server(
                    statusCode: 503,
                    code: "server_unavailable",
                    message: "Catalog is warming up.",
                    retryable: true
                )
            )
        }
    }

    func testChatApprovalStreamRecoveryAndDigestBoundDecision() async throws {
        let pending = """
        {"id":"approval_12345678","surface":"chat","sessionId":"generation_12345678","conversationId":"conv_12345678","connectorId":"apple-mail","connectorLabel":"Apple Mail","toolName":"send_message","action":"send_message","riskClass":"external_write","preview":"Apple Mail wants to send a message.","detail":{"to":"person@example.com","subject":"Hello","body":"Safe preview"},"receiptDigest":"digest_12345678","status":"pending","decision":null,"canAllowScope":false,"derivedFromUntrusted":false,"expiresAt":"2026-07-22T00:15:00.000Z","decidedAt":null,"completedAt":null,"createdAt":"2026-07-22T00:00:00.000Z"}
        """
        let decided = """
        {"id":"approval_12345678","surface":"chat","sessionId":"generation_12345678","conversationId":"conv_12345678","connectorId":"apple-mail","connectorLabel":"Apple Mail","toolName":"send_message","action":"send_message","riskClass":"external_write","preview":"Apple Mail wants to send a message.","detail":{"to":"person@example.com","subject":"Hello","body":"Safe preview"},"receiptDigest":"digest_12345678","status":"allowed","decision":"allow_once","canAllowScope":false,"derivedFromUntrusted":false,"expiresAt":"2026-07-22T00:15:00.000Z","decidedAt":"2026-07-22T00:01:00.000Z","completedAt":null,"createdAt":"2026-07-22T00:00:00.000Z"}
        """
        let streamBody = """
        data: {"type":"meta","conversationId":"conv_12345678","userMessageId":null,"title":"Approval chat","generationId":"juno-native-generation-approval"}

        data: {"type":"approval","approval":\(pending)}

        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Done","reasoning":null,"model":"openai:gpt-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[]},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(streamBody)])
        let sender = ChatQueueSender(responses: [
            response(#"{"approvals":[\#(pending)]}"#),
            response(#"{"approval":\#(decided)}"#),
        ])
        let client = NativeChatAPIClient(sender: sender, streamer: streamer)

        let events = try await collect(
            client.generationEvents(
                NativeChatGenerationRequest(
                    conversationID: "conv_12345678",
                    modelID: "openai:gpt-5",
                    reasoningEffort: nil,
                    generationID: "juno-native-generation-approval"
                ),
                for: accountID
            )
        )
        guard case .approval(let streamedApproval) = events[1] else {
            return XCTFail("Expected the streamed approval receipt")
        }
        XCTAssertEqual(streamedApproval.receiptDigest, "digest_12345678")
        XCTAssertEqual(streamedApproval.detail["to"]?.stringValue, "person@example.com")

        let recovered = try await client.chatApprovals(
            conversationID: "conv_12345678",
            includeRecent: true,
            for: accountID
        )
        let approval = try XCTUnwrap(recovered.first)
        let result = try await client.decideChatApproval(
            approval,
            decision: .allowOnce,
            for: accountID
        )
        XCTAssertEqual(result.status, .allowed)
        XCTAssertEqual(result.receiptDigest, approval.receiptDigest)

        let requests = await sender.requests
        XCTAssertEqual(requests[0].path, "/api/approvals")
        XCTAssertEqual(
            requests[0].queryItems,
            [
                URLQueryItem(name: "conversationId", value: "conv_12345678"),
                URLQueryItem(name: "includeRecent", value: "1"),
            ]
        )
        XCTAssertEqual(requests[1].path, "/api/approvals/approval_12345678")
        let decisionBody = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(requests[1].body))
                as? [String: String]
        )
        XCTAssertEqual(decisionBody["decision"], "allow_once")
        XCTAssertEqual(decisionBody["receiptDigest"], "digest_12345678")
    }

    private func collect(
        _ stream: AsyncThrowingStream<NativeChatServerEvent, any Error>
    ) async throws -> [NativeChatServerEvent] {
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }
        return events
    }

    private func response(_ body: String, statusCode: Int = 200) -> HTTPResponse {
        HTTPResponse(
            statusCode: statusCode,
            headers: try! HTTPHeaders(["content-type": "application/json"]),
            body: Data(body.utf8)
        )
    }

    /// A run's rows carry their typed payloads when the server sends them,
    /// the done frame carries the persisted run and the reasoning's parts, a
    /// source keeps `cited`, and every SSE `id:` becomes the sequence a
    /// reconnect resumes after.
    func testTheRunAndItsSequenceNumbersSurviveTheWire() async throws {
        let body = """
        id: 1
        data: {"type":"activity","event":{"id":"act-1","kind":"search","title":"Searching the web","detail":"swift 6","createdAt":"2026-09-23T10:00:00.000Z","seq":1,"round":0,"call":{"v":1,"callId":"call-1","tool":"web_search","origin":"juno","title":"Web search","status":"succeeded","round":0,"index":0,"startedAt":"2026-09-23T10:00:00.000Z","args":{"query":"swift 6","limit":5},"figure":{"kind":"results","n":8},"web":{"query":"swift 6","results":[{"title":"Swift 6","url":"https://swift.org"}]}}}}

        id: 2
        data: {"type":"activity","event":{"id":"act-2","kind":"tool","title":"Using Linear","detail":"linear__search","createdAt":"2026-09-23T10:00:02.000Z","tool":{"server":"Linear","name":"linear__search","args":"{}","result":"[]","status":"ok","durationMs":812.4},"call":{"callId":"broken"}}}

        id: 3
        data: {"type":"sources","sources":[{"title":"Swift 6","url":"https://swift.org","snippet":"x","cited":true}]}

        id: 4
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Done [1]","reasoning":"ab","reasoningParts":["a","b"],"model":"openai:gpt-5","createdAt":"2026-09-23T10:00:09.000Z","sources":[{"title":"Swift 6","url":"https://swift.org","snippet":"x","cited":true}],"activity":[{"id":"act-1","kind":"search","title":"Searching the web","createdAt":"2026-09-23T10:00:00.000Z"},{"id":"act-9","kind":"artifact","title":"Artifact verified","createdAt":"2026-09-23T10:00:08.000Z"},{"kind":"broken"}]},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: nil,
                generationID: "juno-native-generation-1"
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }

        let sequences = events.compactMap { event -> Int? in
            if case .sequence(let number) = event { return number }
            return nil
        }
        XCTAssertEqual(sequences, [1, 2, 3, 4])

        guard case .activity(let search) = events[0] else { return XCTFail("expected the search row") }
        XCTAssertEqual(search.seq, 1)
        XCTAssertEqual(search.call?.tool, "web_search")
        XCTAssertEqual(search.call?.status, .succeeded)
        XCTAssertEqual(search.call?.args["limit"], "5")
        XCTAssertEqual(search.call?.figure?.n, 8)
        XCTAssertEqual(search.call?.web?.results.first?.url, "https://swift.org")
        XCTAssertNotNil(search.createdAt)

        guard case .activity(let tool) = events[2] else { return XCTFail("expected the tool row") }
        XCTAssertNil(tool.call, "a call record this build cannot read costs only itself")
        XCTAssertEqual(tool.tool?.durationMs, 812)
        XCTAssertEqual(tool.tool?.status, "ok")

        guard case .sources(let sources) = events[4] else { return XCTFail("expected sources") }
        XCTAssertEqual(sources.first?.cited, true)

        guard case .completed(let done) = events[6] else { return XCTFail("expected done") }
        XCTAssertEqual(done.reasoningParts, ["a", "b"])
        XCTAssertEqual(done.activity.map(\.id), ["act-1", "act-9"])
        XCTAssertEqual(done.activity.last?.kind, .artifact)
        XCTAssertEqual(done.sources.first?.cited, true)
    }

    /// Resuming: which generation is still running, and its frames after the
    /// last one handled.
    func testTheResumeRoutes() async throws {
        let sender = ChatQueueSender(responses: [
            response(#"{"generationId":"juno-native-running-1"}"#),
            response(#"{"error":"Not found"}"#, statusCode: 404),
        ])
        let streamer = ChatQueueStreamer(responses: [streamResponse("""
        id: 8
        data: {"type":"delta","text":" there"}

        id: 9
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hello there","reasoning":null,"model":"openai:gpt-5","createdAt":"2026-09-23T10:00:09.000Z","sources":[]},"finishReason":"stop"}

        """)])
        let client = NativeChatAPIClient(sender: sender, streamer: streamer)

        let running = try await client.activeGeneration(conversationID: "conv_12345678", for: accountID)
        XCTAssertEqual(running, "juno-native-running-1")
        let none = try await client.activeGeneration(conversationID: "conv_12345678", for: accountID)
        XCTAssertNil(none)
        let asked = await sender.requests
        XCTAssertEqual(asked.first?.path, "/api/chat/stream/active")
        XCTAssertEqual(asked.first?.queryItems, [URLQueryItem(name: "conversationId", value: "conv_12345678")])

        let stream = try await client.resumeEvents(generationID: "juno-native-running-1", after: 7, for: accountID)
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }
        XCTAssertEqual(events.first, .textDelta(" there"))
        XCTAssertTrue(events.contains(.sequence(9)))
        let streamed = await streamer.requests
        XCTAssertEqual(streamed.first?.path, "/api/chat/stream/juno-native-running-1")
        XCTAssertEqual(streamed.first?.method, .get)
        XCTAssertEqual(streamed.first?.queryItems, [URLQueryItem(name: "after", value: "7")])
    }

    /// The thread lays what sync lacks — sources, the run, reasoning parts,
    /// versions — over the synced rows, lossily.
    func testTheThreadReadsWhatSyncLacks() async throws {
        let sender = ChatQueueSender(responses: [response(#"""
        {"conversation":{"id":"conv_12345678"},"messages":[
          {"id":"msg-1","role":"USER","content":"Hi"},
          {"id":"msg-2","role":"ASSISTANT","content":"Hello [1]","sources":[{"title":"Swift","url":"https://swift.org","snippet":"","cited":true},{"title":"Bad","url":"javascript:alert(1)","snippet":""}],"activity":[{"id":"a1","kind":"write","title":"Writing the answer","createdAt":"2026-09-23T10:00:03.000Z"}],"reasoningParts":["one"],"versions":[{"id":"v1","model":null,"createdAt":"2026-09-23T09:00:00.000Z"}]},
          {"role":"broken"}
        ],"artifacts":[{"id":"art-1","identifier":"card","type":"HTML","title":"Card","language":null,"currentVersion":1,"content":"<p>x</p>","versions":[],"messageId":"msg-2","createdAt":"2026-09-23T10:00:00.000Z","updatedAt":"2026-09-23T10:00:00.000Z"}]}
        """#)])
        let client = NativeChatAPIClient(sender: sender, streamer: EmptyChatStreamer())
        let thread = try await client.conversationThread(conversationID: "conv_12345678", for: accountID)

        XCTAssertEqual(thread.messages.map(\.id), ["msg-1", "msg-2"])
        let answer = try XCTUnwrap(thread.messages.last)
        XCTAssertEqual(answer.sources.map(\.url.absoluteString), ["https://swift.org"])
        XCTAssertEqual(answer.sources.first?.cited, true)
        XCTAssertEqual(answer.activity.first?.kind, .write)
        XCTAssertEqual(answer.reasoningParts, ["one"])
        XCTAssertEqual(answer.versionCount, 1)
        XCTAssertEqual(thread.artifacts.map(\.identifier), ["card"])
        let asked = await sender.requests
        XCTAssertEqual(asked.first?.path, "/api/conversations/conv_12345678")
    }

    /// The version pager's read: earlier versions, oldest first, with their
    /// own words, model, tokens and sources.
    func testEarlierVersionsAreReadInOrder() async throws {
        let sender = ChatQueueSender(responses: [response(#"""
        {"versions":[
          {"id":"v1","content":"First try","reasoning":"thought","model":"openai:gpt-5","promptTokens":120,"completionTokens":40,"sources":[{"title":"Swift","url":"https://swift.org","snippet":""},{"title":"Bad","url":"javascript:alert(1)","snippet":""}],"createdAt":"2026-09-23T09:00:00.000Z"},
          {"id":"v2","content":"Second try","reasoning":null,"model":null,"promptTokens":null,"completionTokens":null,"sources":null,"createdAt":"2026-09-23T09:30:00.000Z"}
        ]}
        """#)])
        let client = NativeChatAPIClient(sender: sender, streamer: EmptyChatStreamer())
        let versions = try await client.messageVersions(messageID: "msg_12345678", for: accountID)

        XCTAssertEqual(versions.map(\.id), ["v1", "v2"])
        XCTAssertEqual(versions[0].content, "First try")
        XCTAssertEqual(versions[0].model, "openai:gpt-5")
        XCTAssertEqual(versions[0].promptTokens, 120)
        XCTAssertEqual(versions[0].sources.map(\.url.absoluteString), ["https://swift.org"])
        XCTAssertNil(versions[1].model)
        XCTAssertEqual(versions[1].sources, [])
        let asked = await sender.requests
        XCTAssertEqual(asked.first?.path, "/api/messages/msg_12345678/versions")
    }

    /// A page is its index, so one unreadable version fails the read rather
    /// than shifting every later page onto the wrong words.
    func testAnUnreadableVersionFailsTheRead() async throws {
        let sender = ChatQueueSender(responses: [response(#"""
        {"versions":[{"id":"v1","content":"First"},{"id":"v2"}]}
        """#)])
        let client = NativeChatAPIClient(sender: sender, streamer: EmptyChatStreamer())
        do {
            _ = try await client.messageVersions(messageID: "msg_12345678", for: accountID)
            XCTFail("expected a malformed response")
        } catch let error as NativeChatAPIError {
            XCTAssertEqual(error, .malformedResponse)
        }
    }

    /// An earlier version shows its own words, model, tokens and sources, and
    /// none of the live answer's run, cost, finish or error.
    func testAnEarlierVersionShowsOnlyWhatItKept() {
        var live = NativeChatMessage(
            id: "msg-2", conversationID: "conv-1", clientID: nil, role: .assistant,
            content: "Live answer", reasoning: "live thought", model: "anthropic:claude-sonnet-4-6",
            createdAt: Date(timeIntervalSince1970: 0), revision: 1,
            sources: [NativeChatSource(title: "Live", url: URL(string: "https://example.com")!, snippet: "")],
            finishReason: .length, costUSD: 0.02, promptTokens: 900, completionTokens: 300,
            activity: [NativeChatActivity(id: "a", kind: .write, title: "Writing", detail: nil, url: nil)],
            reasoningParts: ["live"], versionCount: 1
        )
        live.feedback = .up
        let shown = live.showing(NativeMessageVersion(
            id: "v1", content: "Old answer", reasoning: nil, model: "openai:gpt-5",
            promptTokens: 100, completionTokens: 20, sources: []
        ))

        XCTAssertEqual(shown.id, "msg-2")
        XCTAssertEqual(shown.content, "Old answer")
        XCTAssertEqual(shown.model, "openai:gpt-5")
        XCTAssertNil(shown.reasoning)
        XCTAssertNil(shown.reasoningParts)
        XCTAssertEqual(shown.sources, [])
        XCTAssertEqual(shown.promptTokens, 100)
        XCTAssertNil(shown.costUSD)
        XCTAssertNil(shown.finishReason)
        XCTAssertEqual(shown.activity, [])
        XCTAssertEqual(shown.feedback, .up)
        XCTAssertEqual(shown.versionCount, 1)
    }

    func testContextReferencesUseTheChatWireWithoutReappendingTheMessage() async throws {
        let streamer = ChatQueueStreamer(responses: [streamResponse("data: {\"type\":\"delta\",\"text\":\"ok\"}\n\n")])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        _ = try await client.generationEvents(NativeChatGenerationRequest(
            conversationID: "conv_12345678", modelID: "openai:gpt-5", reasoningEffort: nil,
            generationID: "context-generation", context: [NativeContextToken(kind: .project, id: "cproject1234", label: "Juno")]
        ), for: accountID)
        let requests = await streamer.requests
        let request = try XCTUnwrap(requests.first)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        let context = try XCTUnwrap(body["context"] as? [[String: Any]])
        XCTAssertEqual(context.first?["kind"] as? String, "project")
        XCTAssertEqual(context.first?["id"] as? String, "cproject1234")
        XCTAssertNil(body["message"])
    }

    func testMentionTriggerKeepsEmailAddressesAsPlainText() {
        XCTAssertNil(NativeContextMention.query(in: "liam@example.com"))
        XCTAssertEqual(NativeContextMention.query(in: "Look at @Ju"), "Ju")
        let token = NativeContextToken(kind: .project, id: "cproject1234", label: "Juno")
        XCTAssertEqual(NativeContextMention.inserting(token, in: "Look at @Ju"), "Look at @Juno ")
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
                    for byte in data {
                        continuation.yield(byte)
                        await Task.yield()
                    }
                    continuation.finish()
                }
            }
        )
    }
}

private actor ChatQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse] = []) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPResponse
    {
        requests.append(request)
        guard !responses.isEmpty else {
            return HTTPResponse(
                statusCode: 500,
                headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        return responses.removeFirst()
    }
}

private actor ChatQueueStreamer: NativeAuthenticatedByteStreaming {
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

private actor EmptyChatStreamer: NativeAuthenticatedByteStreaming {
    func stream(_: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPByteStreamResponse
    {
        throw NativeChatAPIError.malformedResponse
    }
}
