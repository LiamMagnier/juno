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
            .ok(#"{"events":[{"seq":5,"kind":"text_delta","payload":{},"createdAt":"2026-07-22T10:00:00.000Z"}]}"#)
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)
        await model.pollEvents(deviceID: "d1", sessionID: "s1")
        XCTAssertEqual(model.cursor, 5)

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

    /// Host discovery is the entry point to the whole Remote surface: every
    /// other call needs a `deviceID`, and nothing else can supply one.
    func testLoadHostsDecodesWorkspaceNamesAndOnlineState() async throws {
        let transport = BrowserTransport(responses: [
            .ok("""
            {"devices":[
              {"id":"d1","name":"Studio","platform":"macos","online":true,
               "lastSeenAt":"2026-07-22T10:00:00.000Z",
               "workspaces":[{"name":"juno"},{"name":"juno-windows"}]}
            ]}
            """)
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.loadHosts()

        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.hosts.map(\.id), ["d1"])
        XCTAssertEqual(model.hosts.first?.workspaceNames, ["juno", "juno-windows"])
        XCTAssertTrue(model.hosts.first?.online == true)
    }

    /// A machine you can reach right now is the one you want to tap; it must
    /// never sort below a laptop that has been shut since Tuesday.
    func testHostsAreOrderedOnlineFirstThenMostRecentlySeen() async throws {
        let transport = BrowserTransport(responses: [
            .ok("""
            {"devices":[
              {"id":"stale-online","name":"A","platform":"macos","online":true,
               "lastSeenAt":"2026-07-20T10:00:00.000Z","workspaces":[]},
              {"id":"fresh-offline","name":"B","platform":"macos","online":false,
               "lastSeenAt":"2026-07-22T10:00:00.000Z","workspaces":[]},
              {"id":"older-offline","name":"C","platform":"windows","online":false,
               "lastSeenAt":"2026-07-19T10:00:00.000Z","workspaces":[]}
            ]}
            """)
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.loadHosts()

        XCTAssertEqual(model.hosts.map(\.id), ["stale-online", "fresh-offline", "older-offline"])
    }

    /// A host that omits `online` is treated as offline. Claiming a machine is
    /// reachable when the relay would not say so is the worse failure — it sends
    /// someone into a session that cannot answer.
    func testAHostWithoutAnOnlineFieldIsTreatedAsOffline() async throws {
        let transport = BrowserTransport(responses: [
            .ok("""
            {"devices":[
              {"id":"d1","name":"Studio","platform":"macos",
               "lastSeenAt":"2026-07-22T10:00:00.000Z","workspaces":[]}
            ]}
            """)
        ])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.loadHosts()

        XCTAssertEqual(model.hosts.first?.online, false)
    }

    /// Offline and refused are different states with different remedies:
    /// retrying helps one and cannot help the other.
    func testARefusedHostListFailsRatherThanReportingOffline() async throws {
        let transport = BrowserTransport(responses: [.status(403)])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)

        await model.loadHosts()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertTrue(model.hosts.isEmpty)
        XCTAssertNotNil(model.lastErrorDescription)
    }

    /// Signed out, the model must not reach the network at all.
    func testLoadHostsDoesNothingWithoutAnAccount() async throws {
        let transport = BrowserTransport(responses: [.ok(#"{"devices":[]}"#)])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))

        await model.loadHosts()

        XCTAssertEqual(model.phase, .idle)
        await AssertNoRequests(transport)
    }

    private func AssertNoRequests(_ transport: BrowserTransport) async {
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
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
