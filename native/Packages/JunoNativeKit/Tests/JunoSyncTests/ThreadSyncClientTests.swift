import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest

@testable import JunoSync

/// Per-thread sync (docs/code-v2/REMOTE-CONTROL.md §Sync): the routes, the
/// debounced draft writes stamped with the last keystroke, and echo handling.
final class ThreadSyncClientTests: XCTestCase {
    private let account = try! AccountID("account-a")

    func testKeysAndUpdateBody() throws {
        XCTAssertEqual(ThreadSyncKey.chat("c1"), "chat:c1")
        XCTAssertEqual(ThreadSyncKey.code(deviceID: "mac1", sessionID: "s1"), "code:mac1:s1")
        let at = Date(timeIntervalSince1970: 1_760_000_000)
        let body = try ThreadSyncUpdate(
            draft: "hi", draftUpdatedAt: at, prefs: ThreadSyncPrefs(model: "opus", mode: "full", skills: ["tidy"]), device: "iphone"
        ).body()
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["draft"] as? String, "hi")
        XCTAssertEqual(object["device"] as? String, "iphone")
        XCTAssertEqual(object["draftUpdatedAt"] as? String, ThreadSyncDates.format(at))
        XCTAssertEqual((object["prefs"] as? [String: Any])?["mode"] as? String, "full")
        XCTAssertNil(object["read"])
    }

    func testWriteAndChangesNameTheirRoutes() async throws {
        let row = #"{"key":"code:mac1:s1","draft":"x","draftUpdatedAt":"2026-10-10T12:00:00.000Z","draftBy":"mac","prefs":{"mode":"full"},"prefsUpdatedAt":null,"needsYou":true,"readAt":null,"updatedAt":"2026-10-10T12:00:00.000Z"}"#
        let transport = SyncTransport(responses: [
            (200, "{\"thread\":\(row)}"),
            (200, "{\"threads\":[\(row)],\"cursor\":\"2026-10-10T12:00:00.000Z|code:mac1:s1\"}"),
        ])
        let client = ThreadSyncClient(sender: transport)
        let saved = try await client.write("code:mac1:s1", ThreadSyncUpdate(needsYou: true), for: account)
        XCTAssertTrue(saved.needsYou)
        XCTAssertEqual(saved.prefs.mode, "full")
        let page = try await client.changes(after: "c0", waitMs: 60_000, keys: ["code:mac1:s1"], for: account)
        XCTAssertEqual(page.threads.count, 1)
        XCTAssertEqual(page.cursor, "2026-10-10T12:00:00.000Z|code:mac1:s1")
        let requests = await transport.requests
        XCTAssertEqual(requests[0].path, "/api/sync/threads/code%3Amac1%3As1")
        XCTAssertEqual(requests[0].method, .put)
        XCTAssertEqual(requests[1].path, "/api/sync/threads")
        XCTAssertEqual(requests[1].queryItems.first { $0.name == "wait" }?.value, "20000", "the wait is capped at 20 s")
    }

    func testDraftsAreDebouncedToOneWriteStampedWithTheLastKeystroke() async throws {
        let recorder = Recorder()
        let syncer = ThreadDraftSyncer(device: "iphone", delay: .milliseconds(40)) { key, update in
            await recorder.append(key, update)
        }
        let last = Date(timeIntervalSince1970: 1_760_000_100)
        await syncer.draftChanged("chat:c1", text: "h", at: Date(timeIntervalSince1970: 1_760_000_000))
        await syncer.draftChanged("chat:c1", text: "hel", at: Date(timeIntervalSince1970: 1_760_000_050))
        await syncer.draftChanged("chat:c1", text: "hello", at: last)
        try await Task.sleep(for: .milliseconds(200))
        let writes = await recorder.writes
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0].1.draft, "hello")
        XCTAssertEqual(writes[0].1.draftUpdatedAt, last)
        XCTAssertEqual(writes[0].1.device, "iphone")
    }

    func testEchoesAndInFlightTypingAreNotAppliedBack() async throws {
        let syncer = ThreadDraftSyncer(device: "mac", delay: .seconds(10)) { _, _ in }
        await syncer.draftChanged("chat:c1", text: "typing", at: Date())
        let remote = ThreadSyncState(key: "chat:c1", draft: "from phone", draftBy: "iphone", updatedAt: Date())
        let applyWhileTyping = await syncer.shouldApply(remote)
        XCTAssertFalse(applyWhileTyping, "unsent typing here wins over a remote draft")
        await syncer.flush("chat:c1")
        let echo = ThreadSyncState(key: "chat:c1", draft: "typing", draftBy: "mac", updatedAt: Date())
        let applyEcho = await syncer.shouldApply(echo)
        XCTAssertFalse(applyEcho, "its own echo is not applied back")
        let applyRemote = await syncer.shouldApply(remote)
        XCTAssertTrue(applyRemote)
    }

    func testHandOffPostsTheThreadAndSurfacesARefusal() async throws {
        let transport = SyncTransport(responses: [(200, #"{"sent":1}"#), (404, #"{"sent":0,"error":"No iPhone signed in to Alevr can receive it."}"#)])
        let client = ThreadSyncClient(sender: transport)
        try await client.handOff(.code(deviceID: "mac1", sessionID: "s1", title: "Fix"), to: .ios, for: account)
        let body = await transport.requests[0].body
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body ?? Data()) as? [String: String])
        XCTAssertEqual(object, ["target": "ios", "kind": "code", "id": "s1", "deviceId": "mac1", "title": "Fix"])
        do {
            try await client.handOff(.chat("c1"), to: .ios, for: account)
            XCTFail("expected a refusal")
        } catch let JunoHandoffError.refused(message) {
            XCTAssertTrue(message.contains("iPhone"))
        }
    }
}

private actor Recorder {
    var writes: [(String, ThreadSyncUpdate)] = []
    func append(_ key: String, _ update: ThreadSyncUpdate) { writes.append((key, update)) }
}

private actor SyncTransport: NativeAuthenticatedRequestSending {
    private var responses: [(Int, String)]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [(Int, String)]) {
        self.responses = responses
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = responses.isEmpty ? (500, "{}") : responses.removeFirst()
        return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}
