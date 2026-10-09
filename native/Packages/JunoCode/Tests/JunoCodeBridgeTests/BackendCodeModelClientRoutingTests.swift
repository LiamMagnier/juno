import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoCodeBridge
import JunoCodeCore
import JunoCodeRuntime

/// Code v3 (Mac): a routed child's client sends whose key pays and the
/// chosen context tier with every call, on every wire protocol.
final class BackendCodeModelClientRoutingTests: XCTestCase {
    private let accountID = try! AccountID("account-1")

    private final class RecordingStreamer: NativeAuthenticatedByteStreaming, @unchecked Sendable {
        private(set) var requests: [NativeBearerRequest] = []

        func stream(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPByteStreamResponse {
            requests.append(request)
            throw AgentModelClientError.transport(message: "recorded")
        }
    }

    private func request(_ modelID: String) -> ModelTurnRequest {
        ModelTurnRequest(
            sessionID: CodeSessionID(), systemPrompt: "s", messages: [.user("hi")], tools: [],
            modelID: modelID, reasoningEffort: nil
        )
    }

    private func drain(_ client: BackendCodeModelClient, _ modelID: String) async {
        do { for try await _ in client.streamTurn(request(modelID)) {} } catch {}
    }

    func testRoutedClientSendsBillingAndTierOnEveryProtocol() async {
        let streamer = RecordingStreamer()
        let base = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        XCTAssertTrue(base.sentRoutingHeaders.isEmpty, "the session's own client sends no routing headers")
        let byok = base.routed(billing: .byok, contextTokens: 1_000_000)
        await drain(byok, "anthropic:claude-sonnet-5")
        await drain(byok, "openai:gpt-5.4")
        await drain(byok, "openai:gpt-5.3-codex")
        XCTAssertEqual(streamer.requests.count, 3)
        for request in streamer.requests {
            XCTAssertEqual(request.headers["x-alevr-billing"], "byok")
            XCTAssertEqual(request.headers["x-alevr-context-tokens"], "1000000")
            XCTAssertEqual(request.headers["Accept"], "text/event-stream", "the protocol's own headers still win")
        }
        let alevr = base.routed(billing: .alevr, contextTokens: nil)
        XCTAssertEqual(alevr.sentRoutingHeaders, ["x-alevr-billing": "alevr"])
    }
}
