import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

/// Resuming a stream (spec §6.15, brief §6.9): a dropped stream is picked up
/// after its last frame through the same handling, a generation this Mac is
/// not streaming is followed when its conversation opens, and the thread
/// lays back what sync does not carry.
@MainActor
final class NativeStreamResumeTests: XCTestCase {
    private let conversationID = "conv_12345678"

    /// The stream dies after two frames; the resume route is asked for what
    /// came after frame 2, and the answer completes through it.
    func testADroppedStreamResumesAfterItsLastFrame() async throws {
        let streamer = ResumeStreamer(bodies: [
            "/api/chat": """
            id: 1
            data: {"type":"meta","conversationId":"conv_12345678","userMessageId":null,"title":"Resumed","generationId":null}

            id: 2
            data: {"type":"delta","text":"Hello"}


            """,
            "/api/chat/stream/": """
            id: 3
            data: {"type":"delta","text":" there"}

            id: 4
            data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hello there","reasoning":null,"model":"openai:gpt-5","createdAt":"2099-01-01T00:00:00.000Z","sources":[{"title":"Swift","url":"https://swift.org","snippet":"","cited":false}],"activity":[{"id":"a1","kind":"write","title":"Writing the answer","createdAt":"2099-01-01T00:00:00.000Z"}]},"finishReason":"stop"}


            """,
        ])
        let (model, _) = try await makeModel(streamer: streamer)
        XCTAssertTrue(model.sendMessage(
            conversationID: conversationID,
            prompt: "Say hello",
            modelID: "openai:gpt-5",
            reasoningEffort: nil
        ))
        try await waitUntilIdle(model)

        let requests = await streamer.requests
        XCTAssertEqual(requests.count, 2)
        let resume = try XCTUnwrap(requests.last)
        XCTAssertTrue(resume.path.hasPrefix("/api/chat/stream/juno-native-"), resume.path)
        XCTAssertEqual(resume.queryItems, [URLQueryItem(name: "after", value: "2")])

        let answer = try XCTUnwrap(model.selectedMessages.last)
        XCTAssertEqual(answer.role, .assistant)
        XCTAssertEqual(answer.content, "Hello there")
        XCTAssertNil(answer.errorDescription)
        XCTAssertEqual(answer.sources.map(\.url.absoluteString), ["https://swift.org"])
        XCTAssertEqual(answer.activity.map(\.id), ["a1"])
        XCTAssertNil(model.chatErrorDescription)
    }

    /// A conversation that ends on a question while a generation is still
    /// running on the server: opening it follows that generation from its
    /// first frame.
    func testAnOpenedConversationFollowsAGenerationStillRunning() async throws {
        let streamer = ResumeStreamer(bodies: [
            "/api/chat/stream/": """
            id: 1
            data: {"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"","generationId":"juno-native-elsewhere"}

            id: 2
            data: {"type":"delta","text":"Still here"}

            id: 3
            data: {"type":"done","message":{"id":"assistant_99","role":"ASSISTANT","content":"Still here","reasoning":null,"model":"openai:gpt-5","createdAt":"2099-01-01T00:00:00.000Z","sources":[]},"finishReason":"stop"}


            """,
        ])
        let (model, sender) = try await makeModel(
            streamer: streamer,
            question: true,
            responses: ["/api/chat/stream/active": Data(#"{"generationId":"juno-native-elsewhere"}"#.utf8)]
        )
        XCTAssertEqual(model.selectedMessages.last?.role, .user)

        await model.resumeActiveGeneration(conversationID: conversationID)
        try await waitUntilIdle(model)

        let asked = await sender.paths
        XCTAssertTrue(asked.contains("/api/chat/stream/active"))
        let requests = await streamer.requests
        XCTAssertEqual(requests.first?.path, "/api/chat/stream/juno-native-elsewhere")
        XCTAssertEqual(requests.first?.queryItems, [URLQueryItem(name: "after", value: "0")])
        XCTAssertEqual(model.selectedMessages.last?.content, "Still here")
    }

    /// Nothing running: no stream is opened and no placeholder appears.
    func testNothingRunningLeavesTheTranscriptAlone() async throws {
        let streamer = ResumeStreamer(bodies: [:])
        let (model, _) = try await makeModel(streamer: streamer, question: true)
        await model.resumeActiveGeneration(conversationID: conversationID)
        XCTAssertFalse(model.isGenerating)
        XCTAssertEqual(model.selectedMessages.map(\.role), [.user])
        let requests = await streamer.requests
        XCTAssertTrue(requests.isEmpty)
    }

    /// The thread's sources and run are laid over the synced row, which has
    /// neither — so they survive a reload.
    func testTheThreadIsLaidOverTheSyncedRows() async throws {
        let thread = Data(#"""
        {"conversation":{"id":"conv_12345678"},"messages":[
          {"id":"msg-q","role":"USER","content":"Question"},
          {"id":"msg-a","role":"ASSISTANT","content":"Answer [1]","sources":[{"title":"Swift","url":"https://swift.org","snippet":"","cited":true}],"activity":[{"id":"w","kind":"write","title":"Writing the answer","createdAt":"2026-09-23T10:00:03.000Z"}]}
        ],"artifacts":[]}
        """#.utf8)
        let (model, _) = try await makeModel(
            streamer: ResumeStreamer(bodies: [:]),
            question: true,
            answer: true,
            responses: ["/api/conversations/conv_12345678": thread]
        )
        XCTAssertEqual(model.selectedMessages.last?.sources, [])

        await model.hydrateThread(conversationID: conversationID)
        let answer = try XCTUnwrap(model.selectedMessages.last)
        XCTAssertEqual(answer.id, "msg-a")
        XCTAssertEqual(answer.sources.first?.cited, true)
        XCTAssertEqual(answer.activity.map(\.id), ["w"])

        await model.reload()
        XCTAssertEqual(model.selectedMessages.last?.sources.count, 1, "the overlay outlives a reload")
    }

    // MARK: Harness

    private func waitUntilIdle(_ model: NativeConversationModel<InMemoryTransactionalStore>) async throws {
        let deadline = Date().addingTimeInterval(10)
        while model.isGenerating, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(model.isGenerating, "the turn never finished")
    }

    private func makeModel(
        streamer: ResumeStreamer,
        question: Bool = false,
        answer: Bool = false,
        responses: [String: Data] = [:]
    ) async throws -> (NativeConversationModel<InMemoryTransactionalStore>, ResumeSender) {
        let account = "account-a"
        let repository = InMemoryTransactionalStore()
        var operations: [StorageOperation] = [
            .upsert(StoredRecord(
                accountID: StorageAccountID(account),
                key: RecordKey(namespace: "conversation", id: conversationID),
                revision: 1,
                updatedAt: Date(timeIntervalSince1970: 10),
                payload: Data("""
                {"id":"conv_12345678","title":"Resume","model":"openai:gpt-5","kind":"chat",\
                "pinned":false,"archivedAt":null,"createdAt":"2026-07-21T12:00:00.000Z",\
                "updatedAt":"2026-07-21T12:01:00.000Z","lastMessageAt":"2026-07-21T12:02:00.000Z"}
                """.utf8)
            )),
        ]
        if question {
            operations.append(.upsert(StoredRecord(
                accountID: StorageAccountID(account),
                key: RecordKey(namespace: "message", id: "msg-q"),
                revision: 1,
                updatedAt: Date(timeIntervalSince1970: 11),
                payload: Data("""
                {"id":"msg-q","conversationId":"conv_12345678","clientId":null,"role":"USER",\
                "content":"Question","createdAt":"2026-07-21T12:02:00.000Z"}
                """.utf8)
            )))
        }
        if answer {
            operations.append(.upsert(StoredRecord(
                accountID: StorageAccountID(account),
                key: RecordKey(namespace: "message", id: "msg-a"),
                revision: 1,
                updatedAt: Date(timeIntervalSince1970: 12),
                payload: Data("""
                {"id":"msg-a","conversationId":"conv_12345678","clientId":null,"role":"ASSISTANT",\
                "content":"Answer [1]","createdAt":"2026-07-21T12:03:00.000Z"}
                """.utf8)
            )))
        }
        _ = try await repository.apply(StorageTransaction(accountID: StorageAccountID(account), operations: operations))
        let catalog = Data(#"{"manifestVersion":"v1-catalog","contractDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generatedAt":"2026-07-22T00:00:00.000Z","models":[{"id":"openai:gpt-5","provider":{"id":"openai","displayName":"OpenAI"},"displayName":"GPT-5","availability":"available","minimumPlan":"free","supportedReasoningEfforts":["low","high"],"reasoning":{"canDisable":true},"capabilities":{"streaming":true}}]}"#.utf8)
        var known = responses
        known["/api/v1/models"] = catalog
        let sender = ResumeSender(responses: known)
        let offline = ResumeOfflineSender()
        let outbox = InMemoryMutationOutbox()
        let coordinator = NativeSyncCoordinator(repository: repository, sender: offline)
        let model = NativeConversationModel(
            repository: repository,
            outbox: outbox,
            drainer: NativeMutationDrainer(repository: repository, outbox: outbox, sender: offline),
            syncModel: NativeSyncModel(
                coordinator: coordinator,
                monitor: NativeSyncMonitor(coordinator: coordinator, streamer: offline)
            ),
            chatClient: NativeChatAPIClient(sender: sender, streamer: streamer),
            opensMostRecentConversationOnLoad: false
        )
        await model.start(for: try AccountID(account))
        model.selectedConversationID = conversationID
        return (model, sender)
    }
}

/// Answers known paths with 200, the question append with a matching row,
/// and everything else with 404.
private actor ResumeSender: NativeAuthenticatedRequestSending {
    private let responses: [String: Data]
    private(set) var paths: [String] = []

    init(responses: [String: Data]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        paths.append(request.path)
        if request.path.hasSuffix("/messages"), request.method == .post,
            let body = request.body,
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let turn = (object["turns"] as? [[String: Any]])?.first,
            let clientID = turn["clientId"] as? String
        {
            let reply = #"{"conversationId":"conv_12345678","messages":[{"clientId":"\#(clientID)","id":"msg-appended","role":"USER","content":"Say hello","createdAt":"2099-01-01T00:00:00.000Z","created":true}]}"#
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(reply.utf8))
        }
        guard let body = responses[request.path] else {
            return HTTPResponse(statusCode: 404, headers: HTTPHeaders(), body: Data(#"{"error":"Not found"}"#.utf8))
        }
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: body)
    }
}

/// One SSE body per route: `/api/chat`, and the resume route by prefix.
private actor ResumeStreamer: NativeAuthenticatedByteStreaming {
    private let bodies: [String: String]
    private(set) var requests: [NativeBearerRequest] = []

    init(bodies: [String: String]) { self.bodies = bodies }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        requests.append(request)
        let key = request.path.hasPrefix("/api/chat/stream/") ? "/api/chat/stream/" : request.path
        guard let body = bodies[key] else {
            return HTTPByteStreamResponse(
                statusCode: 404,
                headers: try HTTPHeaders(["content-type": "application/json"]),
                bytes: AsyncThrowingStream { $0.finish() }
            )
        }
        let data = Data(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                Task {
                    for byte in data { continuation.yield(byte) }
                    continuation.finish()
                }
            }
        )
    }
}

private struct ResumeOfflineSender: NativeAuthenticatedRequestSending, NativeAuthenticatedByteStreaming, Sendable {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }

    func stream(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        throw URLError(.notConnectedToInternet)
    }
}
