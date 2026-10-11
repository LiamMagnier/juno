import Foundation
import JunoAPI
import JunoAuth
import JunoCodeCore
import JunoCore
import JunoSync
import XCTest
@testable import JunoCodeRemote

/// The link's push stream on the iPhone: SSE framing, batches the moment the
/// backend writes them, the offline and unpaired frames, the fallback to the
/// poll on an older backend, an unreadable event that no longer sinks a whole
/// batch, and the access picker reaching the open thread at once.
final class CodeLinkStreamTests: XCTestCase {
    // MARK: SSE

    func testParserJoinsDataLinesSkipsHeartbeatsAndAcceptsCRLF() {
        var parser = CodeLinkSSEParser()
        var frames: [String] = []
        for byte in Array(": open\n\ndata: {\"a\":1}\r\n\r\n: ping\n\ndata: x\ndata: y\n\n".utf8) {
            if let payload = parser.consume(byte) { frames.append(String(decoding: payload, as: UTF8.self)) }
        }
        XCTAssertEqual(frames, [#"{"a":1}"#, "x\ny"])
    }

    // MARK: The stream

    func testBatchesArriveAsTheyAreWrittenWithTheCursorsInTheBody() async throws {
        let streamer = FakeStreamer()
        let client = CodeLinkClient(sender: streamer, accountID: Fixture.account)
        XCTAssertTrue(client.canStream)
        let batches = try await client.stream("mac 1", cursors: ["s1": 3], globalCursor: 7)
        let request = try XCTUnwrap(streamer.requests.first)
        XCTAssertEqual(request.path, "/api/code/v2/link/mac%201/stream")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: Any])
        XCTAssertEqual(body["cursors"] as? [String: Int], ["s1": 3])
        XCTAssertEqual(body["globalCursor"] as? Int, 7)

        var iterator = batches.makeAsyncIterator()
        var latencies: [Duration] = []
        for sequence in 4...13 {
            let written = ContinuousClock.now
            streamer.write(": ping\n\n")
            streamer.write("data: {\"events\":[\(Self.event(sequence))]}\n\n")
            let batch = try await iterator.next()
            latencies.append(ContinuousClock.now - written)
            XCTAssertEqual(batch?.map(\.sequence), [sequence])
        }
        XCTAssertLessThan(latencies.max() ?? .zero, .milliseconds(50), "a written frame is applied at once, no timer in between")
        streamer.finish()
        let end = try await iterator.next()
        XCTAssertNil(end, "the backend's window ended: the caller opens it again")
    }

    func testOfflineAndUnpairedFramesEndTheStreamWithTheirErrors() async throws {
        let streamer = FakeStreamer()
        let client = CodeLinkClient(sender: streamer, accountID: Fixture.account)
        let offline = try await client.stream("mac", cursors: [:], globalCursor: -1)
        streamer.write("data: {\"offline\":true,\"message\":\"Studio is asleep.\"}\n\n")
        do {
            for try await _ in offline {}
            XCTFail("expected offline")
        } catch {
            XCTAssertEqual(error as? CodeLinkError, .offline(message: "Studio is asleep."))
        }

        let again = FakeStreamer()
        let unpaired = try await CodeLinkClient(sender: again, accountID: Fixture.account).stream("mac", cursors: [:], globalCursor: -1)
        again.write("data: {\"error\":\"Pair it on Studio.\"}\n\n")
        do {
            for try await _ in unpaired {}
            XCTFail("expected not paired")
        } catch {
            XCTAssertEqual(error as? CodeLinkError, .notPaired(message: "Pair it on Studio."))
        }
    }

    func testAnOlderBackendWithoutTheStreamFallsBackAndAGoneMacIsTyped() async throws {
        let html = FakeStreamer(status: 404, contentType: "text/html")
        do {
            _ = try await CodeLinkClient(sender: html, accountID: Fixture.account).stream("mac", cursors: [:], globalCursor: -1)
            XCTFail("expected unavailable")
        } catch {
            XCTAssertTrue(error is CodeLinkClient.StreamUnavailable)
        }
        let gone = FakeStreamer(status: 404, contentType: "application/json")
        gone.write(#"{"error":"This computer is not paired with your account."}"#)
        gone.finish()
        do {
            _ = try await CodeLinkClient(sender: gone, accountID: Fixture.account).stream("mac", cursors: [:], globalCursor: -1)
            XCTFail("expected unpaired")
        } catch {
            XCTAssertEqual(error as? CodeLinkError, .unpairedMac)
        }
        // A sender that cannot stream bytes never tries.
        let plain = FakeSender { _ in FakeSender.json([:]) }
        XCTAssertFalse(CodeLinkClient(sender: plain, accountID: Fixture.account).canStream)
    }

    func testOneUnreadableEventNoLongerSinksTheWholePoll() async throws {
        let body = Data(#"{"events":[\#(Self.event(4)),{"type":"event","stream":"session","sessionId":"s1","sequence":5,"event":{"type":"item.added","item":{"kind":"approval_request"}}},\#(Self.event(6))]}"#.utf8)
        let sender = FakeSender { _ in HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: body) }
        let events = try await CodeLinkClient(sender: sender, accountID: Fixture.account).poll("mac", cursors: ["s1": 3], globalCursor: -1)
        XCTAssertEqual(events.map(\.sequence), [4, 6], "the bad one is skipped; the reducer sees the gap and re-opens")
    }

    // MARK: The model

    @MainActor
    func testTheModelFollowsOverTheStreamAndSendsTheAccessPickerAtOnce() async throws {
        let streamer = FakeStreamer { request in
            let (kind, type) = FakeSender.command(request)
            if request.path == "/api/code/pairing/pairs" {
                return FakeSender.json(["pairs": [[
                    "id": "p1", "kind": "phone", "name": "iPhone", "platform": "ios", "deviceId": "mac1",
                    "deviceName": "Studio", "createdAt": "2026-10-10T09:00:00Z", "lastUsedAt": "2026-10-10T09:00:00Z",
                ]]])
            }
            if request.path.hasPrefix("/api/sync/threads") {
                return FakeSender.json(["thread": NSNull(), "threads": [], "cursor": NSNull()])
            }
            guard kind == "rpc" else { return FakeSender.json(["events": []]) }
            switch type {
            case "host.info": return FakeSender.rpcReply(request, result: ["name": "Studio", "sharedFolders": ["/Users/me/code"]])
            case "session.list": return FakeSender.rpcReply(request, result: ["sessions": []])
            case "provider.list": return FakeSender.rpcReply(request, result: ["instances": []])
            case "skills.list": return FakeSender.rpcReply(request, result: ["skills": []])
            case "session.open": return FakeSender.rpcReply(request, result: ["sessionId": "s1"])
            default: return FakeSender.rpcReply(request)
            }
        }
        let model = CodeLinkRemoteModel(sender: streamer, sleep: { _ in try await Task.sleep(for: .milliseconds(5)) })
        model.start(for: Fixture.account)
        await model.refreshMacs()
        await model.select("mac1")
        await model.open("s1")
        let link = Task { await model.runLink() }
        defer { link.cancel() }
        try await waitUntil { streamer.streamRequests > 0 }
        streamer.write("data: {\"events\":[\(Self.snapshot(4))]}\n\n")
        try await waitUntil { model.openThread?.cursor == 4 }
        XCTAssertFalse(streamer.commands.contains { $0.type == "session.setMode" }, "nothing is sent until the picker moves")

        model.composer.runtimeMode = model.composer.runtimeMode == .full ? .autoEdit : .full
        let picked = model.composer.runtimeMode.rawValue
        try await waitUntil { streamer.commands.contains { $0.type == "session.setMode" } }
        let set = try XCTUnwrap(streamer.commands.last { $0.type == "session.setMode" })
        XCTAssertEqual(set.params["sessionId"] as? String, "s1")
        XCTAssertEqual(set.params["runtimeMode"] as? String, picked)
        XCTAssertFalse(streamer.requests.contains { FakeSender.command($0).kind == "poll" }, "no polling while the stream works")
    }

    // MARK: Fixtures

    static func event(_ sequence: Int) -> String {
        #"{"type":"event","stream":"session","sessionId":"s1","sequence":\#(sequence),"at":"2026-10-11T10:00:00Z","event":{"type":"session.state","state":"running"}}"#
    }

    static func snapshot(_ sequence: Int) -> String {
        #"{"type":"event","stream":"session","sessionId":"s1","sequence":\#(sequence),"at":"2026-10-11T10:00:00Z","event":{"type":"session.snapshot","snapshotSequence":\#(sequence),"session":{"id":"s1","cwd":"/Users/me/code/shop","title":"Fix the cart","selection":{"instanceId":"alevr","model":"claude-sonnet-5-5"},"runtimeMode":"full","interactionMode":"default","state":"running","activeTurnId":"t1","items":[],"queue":[]}}}"#
    }

    @MainActor
    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: Duration = .seconds(5)) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now > deadline { return XCTFail("timed out") }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}

/// A sender that also streams bytes: rpc answers from `handler`, and each
/// `/stream` request gets a body this test writes into by hand.
final class FakeStreamer: NativeAuthenticatedRequestSending, NativeAuthenticatedByteStreaming, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [NativeBearerRequest] = []
    private var continuation: AsyncThrowingStream<UInt8, any Error>.Continuation?
    private var pending: [UInt8] = []
    private var finished = false
    private var streams = 0
    private let status: Int
    private let contentType: String
    private let handler: FakeSender.Handler

    init(status: Int = 200, contentType: String = "text/event-stream", _ handler: @escaping FakeSender.Handler = { _ in FakeSender.json([:]) }) {
        self.status = status
        self.contentType = contentType
        self.handler = handler
    }

    var requests: [NativeBearerRequest] { lock.withLock { _requests } }
    var streamRequests: Int { lock.withLock { streams } }
    var commands: [(type: String, params: [String: Any])] {
        requests.compactMap { request in
            guard let body = request.body,
                  let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  object["kind"] as? String == "rpc",
                  let command = object["command"] as? [String: Any],
                  let type = command["type"] as? String
            else { return nil }
            return (type, command["params"] as? [String: Any] ?? [:])
        }
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        lock.withLock { _requests.append(request) }
        return handler(request)
    }

    func stream(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPByteStreamResponse {
        let bytes = AsyncThrowingStream<UInt8, any Error> { continuation in
            lock.withLock {
                _requests.append(request)
                streams += 1
                self.continuation = continuation
                for byte in pending { continuation.yield(byte) }
                pending = []
                if finished { continuation.finish() }
            }
        }
        return HTTPByteStreamResponse(statusCode: status, headers: try HTTPHeaders(["content-type": contentType]), bytes: bytes)
    }

    func write(_ text: String) {
        lock.withLock {
            guard let continuation else { pending += Array(text.utf8); return }
            for byte in text.utf8 { continuation.yield(byte) }
        }
    }

    func finish() {
        lock.withLock {
            finished = true
            continuation?.finish()
        }
    }
}
