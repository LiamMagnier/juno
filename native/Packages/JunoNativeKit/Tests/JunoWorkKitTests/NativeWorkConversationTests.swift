import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest

@testable import JunoWorkKit

/// A task started from a chat: the join the chat's run card follows.
final class NativeWorkConversationTests: XCTestCase {
    private let account = try! AccountID("account-a")

    func testCreateCarriesTheChatAndTheProject() async throws {
        let transport = ConversationTransport(routes: [
            "/api/work/sessions": json(#"{"session":\#(sessionJSON)}"#)
        ])
        let client = NativeWorkClient(transport: transport)

        let session = try await client.createSession(
            goal: "Sort the downloads", conversationID: "conv_1", projectID: "proj_1",
            idempotencyKey: "key-12345", for: account
        )

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let object = try body(of: request)
        XCTAssertEqual(object["conversationId"] as? String, "conv_1")
        XCTAssertEqual(object["projectId"] as? String, "proj_1")
        XCTAssertEqual(session.conversationID, "conv_1")
        XCTAssertEqual(session.projectID, "proj_1")
        XCTAssertNotNil(session.createdAt)
    }

    func testCreateWithoutAChatSendsNeitherKey() async throws {
        let transport = ConversationTransport(routes: [
            "/api/work/sessions": json(#"{"session":\#(sessionJSON)}"#)
        ])
        let client = NativeWorkClient(transport: transport)
        _ = try await client.createSession(
            goal: "Sort the downloads", idempotencyKey: "key-12345", for: account
        )
        let requests = await transport.requests
        let object = try body(of: try XCTUnwrap(requests.first))
        XCTAssertNil(object["conversationId"])
        XCTAssertNil(object["projectId"])
    }

    func testTheListCanBeAskedForOneChat() async throws {
        let transport = ConversationTransport(routes: [
            "/api/work/sessions": json(#"{"sessions":[\#(sessionJSON)]}"#)
        ])
        let client = NativeWorkClient(transport: transport)

        let sessions = try await client.sessions(conversationID: "conv_1", limit: 5, for: account)

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let query = Dictionary(uniqueKeysWithValues: request.queryItems.map { ($0.name, $0.value) })
        XCTAssertEqual(query["conversationId"], "conv_1")
        XCTAssertEqual(query["limit"], "5")
        XCTAssertNil(query["projectId"] ?? nil)
        XCTAssertEqual(sessions.map(\.conversationID), ["conv_1"])
    }

    func testAHostileChatIdentifierNeverReachesTheNetwork() async throws {
        let transport = ConversationTransport()
        let client = NativeWorkClient(transport: transport)
        do {
            _ = try await client.sessions(conversationID: "../x", for: account)
            XCTFail("a path-shaped id must be refused")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .invalidIdentifier)
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
    }

    /// The route takes `pause | resume | cancel`; `stop` was a 400.
    func testStopTravelsAsCancel() async throws {
        let transport = ConversationTransport(routes: [
            "/api/work/runs/run_1/control": json(#"{"run":\#(runJSON)}"#)
        ])
        let client = NativeWorkClient(transport: transport)
        _ = try await client.control(runID: "run_1", .stop, idempotencyKey: "k", for: account)
        _ = try await client.control(runID: "run_1", .pause, idempotencyKey: "k2", for: account)
        let sent = await transport.requests
        let actions = try sent.map { try body(of: $0)["action"] as? String }
        XCTAssertEqual(actions, ["cancel", "pause"])
    }

    /// Create, then start: one key for the composition, held across a failed
    /// start so the retry finds the same session instead of making a second.
    @MainActor
    func testAChatTaskRetryReusesItsKeyAndNamesTheChat() async throws {
        let transport = ConversationTransport(routes: [
            "/api/work/sessions": json(#"{"session":\#(sessionJSON)}"#),
            "/api/work/sessions/sess_1/runs": json(#"{"error":"busy"}"#, status: 503),
        ])
        let model = NativeWorkModel(client: NativeWorkClient(transport: transport))
        await model.start(for: account)
        defer { model.stop() }

        let first = await model.startTask(goal: "Sort the downloads", conversationID: "conv_1")
        XCTAssertNil(first)
        await transport.set("/api/work/sessions/sess_1/runs", json(#"{"run":\#(runJSON)}"#))
        let second = await model.startTask(goal: "Sort the downloads", conversationID: "conv_1")
        XCTAssertEqual(second?.conversationID, "conv_1")

        let sent = await transport.requests
        let creates = try sent
            .filter { $0.path == "/api/work/sessions" && $0.method == .post }
            .map { try body(of: $0) }
        XCTAssertEqual(creates.count, 2)
        XCTAssertEqual(creates[0]["conversationId"] as? String, "conv_1")
        XCTAssertEqual(
            creates[0]["idempotencyKey"] as? String, creates[1]["idempotencyKey"] as? String
        )
        XCTAssertEqual(model.openSession?.conversationID, "conv_1")

        // A different chat is a different composition.
        await transport.set("/api/work/sessions/sess_1/runs", json(#"{"error":"busy"}"#, status: 503))
        _ = await model.startTask(goal: "Sort the downloads", conversationID: "conv_2")
        let later = await transport.requests
        let keys = try later
            .filter { $0.path == "/api/work/sessions" && $0.method == .post }
            .map { try body(of: $0)["idempotencyKey"] as? String }
        XCTAssertNotEqual(keys.last, keys.first)
    }

    func testTheCardFollowsTheNewestComposedTask() {
        let older = summary(id: "a", created: 100, active: 900)
        let newer = summary(id: "b", created: 500, active: 600)
        let elsewhere = summary(id: "c", created: 999, active: 999, conversation: "conv_2")
        XCTAssertEqual(
            NativeWorkModel.newestSession(in: [older, newer, elsewhere], conversationID: "conv_1")?
                .sessionID,
            "b"
        )
        XCTAssertNil(NativeWorkModel.newestSession(in: [elsewhere], conversationID: "conv_1"))
    }

    // MARK: - Fixtures

    private func summary(
        id: String, created: TimeInterval, active: TimeInterval, conversation: String = "conv_1"
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: id, goal: id, status: "running", needsAttention: false,
            requestedTarget: "automatic", effectiveTarget: nil, hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false,
            lastActivityAt: Date(timeIntervalSince1970: active), currentRunID: nil, lastSeq: 0,
            conversationID: conversation, createdAt: Date(timeIntervalSince1970: created)
        )
    }

    private func body(of request: NativeBearerRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.body)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private let sessionJSON = #"""
{"id":"sess_1","title":"Sort the downloads","goal":"Sort the downloads","status":"draft",\#
"needsAttention":false,"requestedTarget":"automatic","pinned":false,"archived":false,\#
"lastActivityAt":"2026-09-24T10:00:00.000Z","createdAt":"2026-09-24T10:00:00.000Z",\#
"conversationId":"conv_1","projectId":"proj_1","lastSeq":0}
"""#

private let runJSON = #"""
{"id":"run_1","sessionId":"sess_1","status":"queued","attempt":1,\#
"requestedTarget":"automatic","lastSeq":0}
"""#

private actor ConversationTransport: NativeWorkTransport {
    private var routes: [String: HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse] = [:]) { self.routes = routes }

    func set(_ path: String, _ response: HTTPResponse) { routes[path] = response }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return routes[request.path]
            ?? HTTPResponse(
                statusCode: 500, headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
    }

    func stream(
        _: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        HTTPByteStreamResponse(
            statusCode: 503,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            bytes: AsyncThrowingStream { $0.finish() }
        )
    }
}
