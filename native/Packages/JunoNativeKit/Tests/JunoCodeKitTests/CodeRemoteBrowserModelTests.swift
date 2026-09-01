import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

@MainActor
final class CodeRemoteBrowserModelTests: XCTestCase {
    private let account = try! AccountID("account-a")

    /// The cursor is what makes reconnecting cheap. A retried or replayed page
    /// must not double-apply, and events must land in sequence order however
    /// the relay happened to return them.
    func testEventsApplyOnceAndInOrder() async throws {
        let transport = BrowserTransport(responses: [
            .ok("""
            {"events":[
              {"seq":2,"kind":"text_delta","payload":{},"createdAt":"2026-07-22T10:00:02.000Z"},
              {"seq":1,"kind":"user_message","payload":{},"createdAt":"2026-07-22T10:00:01.000Z"}
            ]}
            """),
            // The same page again, as a retry would deliver it.
            .ok("""
            {"events":[
              {"seq":1,"kind":"user_message","payload":{},"createdAt":"2026-07-22T10:00:01.000Z"},
              {"seq":2,"kind":"text_delta","payload":{},"createdAt":"2026-07-22T10:00:02.000Z"},
              {"seq":3,"kind":"completed","payload":{},"createdAt":"2026-07-22T10:00:03.000Z"}
            ]}
            """),
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.pollEvents(deviceID: "d1", sessionID: "s1")
        XCTAssertEqual(model.events.map(\.seq), [1, 2], "returned out of order, applied in order")
        XCTAssertEqual(model.cursor, 2)

        await model.pollEvents(deviceID: "d1", sessionID: "s1")
        XCTAssertEqual(
            model.events.map(\.seq), [1, 2, 3],
            "a replayed page must add only what is genuinely new"
        )
        XCTAssertEqual(model.cursor, 3)
    }

    /// Forgetting this is how a previous session's transcript ends up rendered
    /// under a different session's title.
    func testOpeningASessionClearsTheTranscriptAndCursor() async throws {
        let transport = BrowserTransport(responses: [
            .ok(#"{"events":[{"seq":1,"kind":"text_delta","payload":{},"createdAt":"2026-07-22T10:00:00.000Z"}]}"#)
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)
        await model.pollEvents(deviceID: "d1", sessionID: "s1")
        XCTAssertEqual(model.cursor, 1)

        model.openSession("s2")

        XCTAssertTrue(model.events.isEmpty)
        XCTAssertEqual(model.cursor, 0)
    }

    /// An approval that does not name the exact request it answers could be
    /// replayed against a later one.
    func testAnApprovalNamesTheRequestItAnswers() async throws {
        let transport = BrowserTransport(responses: [.ok(commandBody)])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.respondToApproval(
            deviceID: "d1", sessionID: "s1", requestID: "req-7", approved: true
        )

        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.body)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(object["kind"] as? String, "approval")
        let payload = try XCTUnwrap(object["payload"] as? [String: Any])
        XCTAssertEqual(payload["requestId"] as? String, "req-7")
        XCTAssertEqual(payload["approved"] as? Bool, true)
    }

    func testEventGapDoesNotAdvanceTheCursor() async throws {
        let transport = BrowserTransport(responses: [
            .ok(#"{"events":[{"seq":2,"kind":"text_delta","payload":{},"createdAt":"2026-07-22T10:00:00.000Z"}]}"#)
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.pollEvents(deviceID: "d1", sessionID: "s1")

        XCTAssertTrue(model.events.isEmpty)
        XCTAssertEqual(model.cursor, 0)
        XCTAssertEqual(model.phase, .failed)
    }

    func testWatchEventsFoldsTheLiveStreamInOrder() async throws {
        let transport = StreamingBrowserTransport(body:
            "event: events\ndata: {\"type\":\"events\",\"events\":[{\"seq\":1,\"kind\":\"user_message\",\"payload\":{},\"createdAt\":\"2026-07-22T10:00:00.000Z\"},{\"seq\":2,\"kind\":\"completed\",\"payload\":{},\"createdAt\":\"2026-07-22T10:00:01.000Z\"}],\"lastSeq\":2}\n\n"
        )
        let model = CodeRemoteBrowserModel(
            client: NativeCodeRemoteClient(sender: transport, streamer: transport)
        )
        model.start(for: account)

        await model.watchEvents(deviceID: "d1", sessionID: "s1")

        XCTAssertEqual(model.events.map(\.seq), [1, 2])
        XCTAssertEqual(model.cursor, 2)
        XCTAssertEqual(model.phase, .ready)
    }

    func testHostDiscoveryStripsWorkspacePaths() async throws {
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: BrowserTransport(responses: [])))
        model.updateHosts(from: [NativeCodeDevice(
            id: "device-a", name: "Liam's Mac", platform: "macos", appVersion: "1",
            workspaces: [.init(name: "Juno", path: "/Users/liam/Developer/Juno", key: "workspace-a")],
            activeCount: 0, lastSeenAt: Date(timeIntervalSince1970: 1), online: true,
            servesQueuedTasks: true
        )])

        let host = try XCTUnwrap(model.hosts.first)
        XCTAssertEqual(host.workspaceNames, ["Juno"])
        XCTAssertFalse(String(describing: host).contains("/Users/"))
    }

    /// Two actions must never share a key — the relay would silently drop the
    /// second as a duplicate of the first.
    func testEachActionGetsItsOwnIdempotencyKey() async throws {
        let transport = BrowserTransport(responses: [.ok(commandBody), .ok(commandBody)])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.send(deviceID: "d1", sessionID: "s1", text: "first")
        await model.stopGeneration(deviceID: "d1", sessionID: "s1")

        let requests = await transport.requests
        let keys = try requests.map { request -> String in
            let object = try JSONSerialization.jsonObject(with: request.body ?? Data())
                as? [String: Any] ?? [:]
            return object["idempotencyKey"] as? String ?? ""
        }
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys[0], keys[1], "a Stop must not reuse the message's key")
    }

    /// Pressing Stop twice while the first is in flight must not send twice.
    func testASecondCommandIsRefusedWhileOneIsInFlight() async throws {
        let transport = BrowserTransport(responses: [.ok(commandBody)])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        async let first: Void = model.stopGeneration(deviceID: "d1", sessionID: "s1")
        async let second: Void = model.stopGeneration(deviceID: "d1", sessionID: "s1")
        _ = await (first, second)

        let count = await transport.requests.count
        XCTAssertEqual(count, 1, "the second press must be ignored, not queued")
    }

    /// The same outage-versus-refusal split the rest of the app uses. A relay
    /// that answered and refused must not offer a Retry that cannot work.
    func testAnOutageIsOfflineAndARefusalIsFailed() async throws {
        let outage = BrowserTransport(responses: [.throwing(URLError(.notConnectedToInternet))])
        let offlineModel = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: outage))
        offlineModel.start(for: account)
        await offlineModel.loadSessions(deviceID: "d1")
        XCTAssertEqual(offlineModel.phase, .offline)
        XCTAssertFalse(offlineModel.lastErrorDescription?.contains("NSURLErrorDomain") ?? true)

        let refusal = BrowserTransport(responses: [.status(403)])
        let failedModel = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: refusal))
        failedModel.start(for: account)
        await failedModel.loadSessions(deviceID: "d1")
        XCTAssertEqual(failedModel.phase, .failed)
    }

    /// Sign-out must leave nothing of another account's session on screen.
    func testStopClearsEverything() async throws {
        let transport = BrowserTransport(responses: [
            .ok(#"{"events":[{"seq":1,"kind":"text_delta","payload":{},"createdAt":"2026-07-22T10:00:00.000Z"}]}"#)
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)
        await model.pollEvents(deviceID: "d1", sessionID: "s1")
        XCTAssertFalse(model.events.isEmpty)

        model.stop()

        XCTAssertTrue(model.events.isEmpty)
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertTrue(model.hosts.isEmpty)
        XCTAssertEqual(model.cursor, 0)
        XCTAssertEqual(model.phase, .idle)
    }

    private var commandBody: String {
        #"{"command":{"id":"c1","sessionID":"s1","kind":"stop","payload":{},"status":"pending"}}"#
    }
}

private actor BrowserTransport: NativeAuthenticatedRequestSending {
    enum Response {
        case ok(String)
        case status(Int)
        case throwing(any Error)
    }

    private var responses: [Response]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [Response]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else {
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data("{}".utf8))
        }
        switch responses.removeFirst() {
        case .ok(let body):
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
        case .status(let code):
            return HTTPResponse(
                statusCode: code, headers: HTTPHeaders(),
                body: Data(#"{"error":"refused"}"#.utf8)
            )
        case .throwing(let error):
            throw error
        }
    }
}

private actor StreamingBrowserTransport: NativeAuthenticatedRequestSending,
    NativeAuthenticatedByteStreaming
{
    private let body: String

    init(body: String) { self.body = body }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data())
    }

    func stream(
        _ request: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        let bytes = AsyncThrowingStream<UInt8, any Error> { continuation in
            for byte in body.utf8 { continuation.yield(byte) }
            continuation.finish()
        }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try! HTTPHeaders(["content-type": "text/event-stream"]),
            bytes: bytes
        )
    }
}
