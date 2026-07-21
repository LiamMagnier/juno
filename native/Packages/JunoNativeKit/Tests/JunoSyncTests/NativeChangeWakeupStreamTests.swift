import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest
@testable import JunoSync

final class NativeChangeWakeupStreamTests: XCTestCase {
    func testRealSSEBytesDecodeReadyCursorAndDone() async throws {
        let body = """
        event: ready
        data: {"after":"42"}

        : ping

        event: cursor
        data: {"cursor":"45"}

        event: done
        data: {}

        """
        let streamer = WakeupStreamer(response: streamResponse(body))
        let client = NativeChangeWakeupClient(streamer: streamer)

        let stream = try await client.wakeups(after: "42", for: AccountID("account-a"))
        var events: [NativeChangeWakeup] = []
        for try await event in stream { events.append(event) }

        XCTAssertEqual(events, [.ready(after: "42"), .cursor("45"), .done])
        let requests = await streamer.requests
        XCTAssertEqual(requests.first?.path, "/api/v1/changes/stream")
        XCTAssertEqual(requests.first?.queryItems.first?.value, "42")
        XCTAssertEqual(requests.first?.headers["accept"], "text/event-stream")
    }

    func testMalformedCursorEventFailsClosed() async throws {
        let body = "event: cursor\ndata: {\"cursor\":\"0045\"}\n\n"
        let client = NativeChangeWakeupClient(
            streamer: WakeupStreamer(response: streamResponse(body))
        )
        let stream = try await client.wakeups(after: "42", for: AccountID("account-a"))
        do {
            for try await _ in stream {}
            XCTFail("A noncanonical cursor must terminate the stream")
        } catch {
            XCTAssertEqual(error as? NativeChangeWakeupError, .invalidCursor("0045"))
        }
    }

    func testHTTPErrorEnvelopeIsPreservedBeforeStreaming() async throws {
        let response = HTTPByteStreamResponse(
            statusCode: 401,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            bytes: bytes(#"{"error":{"code":"device_revoked","message":"No","requestId":"r1","retryable":false}}"#)
        )
        let client = NativeChangeWakeupClient(streamer: WakeupStreamer(response: response))
        do {
            _ = try await client.wakeups(after: "42", for: AccountID("account-a"))
            XCTFail("HTTP failures must not become an SSE stream")
        } catch {
            XCTAssertEqual(
                error as? NativeChangeWakeupError,
                .server(statusCode: 401, code: "device_revoked")
            )
        }
    }

    private func streamResponse(_ body: String) -> HTTPByteStreamResponse {
        HTTPByteStreamResponse(
            statusCode: 200,
            headers: try! HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: bytes(body)
        )
    }

    private func bytes(_ value: String) -> AsyncThrowingStream<UInt8, any Error> {
        AsyncThrowingStream { continuation in
            for byte in value.utf8 { continuation.yield(byte) }
            continuation.finish()
        }
    }
}

private actor WakeupStreamer: NativeAuthenticatedByteStreaming {
    private let response: HTTPByteStreamResponse
    private(set) var requests: [NativeBearerRequest] = []
    init(response: HTTPByteStreamResponse) { self.response = response }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) -> HTTPByteStreamResponse {
        requests.append(request)
        return response
    }
}
