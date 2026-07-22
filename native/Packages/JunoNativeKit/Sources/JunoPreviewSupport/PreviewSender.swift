#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoSync

/// A request sender for the UI Preview harness that performs **no real
/// network I/O**. It returns canned in-process responses (or fails, for the
/// offline/error scenarios) so the real screens exercise their real code paths
/// against local fixtures. It holds no URLSession, no token, and no transport.
public actor PreviewSender: NativeChatRequestSending {
    private let fails: Bool
    private(set) public var sentRequestCount = 0
    private(set) public var streamRequestCount = 0

    public init(networkFails: Bool) {
        self.fails = networkFails
    }

    public func send(
        _ request: NativeBearerRequest,
        for _: AccountID
    ) async throws -> HTTPResponse {
        sentRequestCount += 1
        if fails { throw URLError(.notConnectedToInternet) }
        return HTTPResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            body: cannedBody(for: request.path)
        )
    }

    public func stream(
        _ request: NativeBearerRequest,
        for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        streamRequestCount += 1
        if fails { throw URLError(.notConnectedToInternet) }
        // The harness never triggers a live chat/change stream; hand back an
        // immediately-finished stream so nothing hangs.
        let bytes = AsyncThrowingStream<UInt8, any Error> { $0.finish() }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream"]),
            bytes: bytes
        )
    }

    /// Minimal, valid canned bodies keyed by path so any incidental call from a
    /// real code path decodes cleanly. Never fetched from a server.
    private func cannedBody(for path: String) -> Data {
        if path.contains("/memory") {
            return Data(#"{"memories":[],"summary":null}"#.utf8)
        }
        if path.contains("/mutations") {
            return Data(#"{"entity":{"id":"preview","revision":1},"entityMappings":{}}"#.utf8)
        }
        return Data("{}".utf8)
    }
}
#endif
