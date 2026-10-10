import Foundation
import JunoAPI
import JunoAuth
import JunoCodeCore
import JunoCore
import JunoSync
@testable import JunoCodeRemote

/// Answers the app's authenticated requests from a script, and records them.
final class FakeSender: NativeAuthenticatedRequestSending, @unchecked Sendable {
    typealias Handler = @Sendable (NativeBearerRequest) -> HTTPResponse
    private let lock = NSLock()
    private var _requests: [NativeBearerRequest] = []
    private let handler: Handler

    init(_ handler: @escaping Handler) { self.handler = handler }

    var requests: [NativeBearerRequest] { lock.withLock { _requests } }

    /// The link commands sent, in order.
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

    static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: try! JSONSerialization.data(withJSONObject: object))
    }

    /// Replies to an rpc with `result` under the request's own command id.
    static func rpcReply(_ request: NativeBearerRequest, result: Any = [:]) -> HTTPResponse {
        let object = (try? JSONSerialization.jsonObject(with: request.body ?? Data())) as? [String: Any]
        let id = (object?["command"] as? [String: Any])?["id"] as? String ?? "x"
        return json(["responses": [["type": "response", "id": id, "ok": true, "result": result]]])
    }

    static func command(_ request: NativeBearerRequest) -> (kind: String, type: String?) {
        let object = (try? JSONSerialization.jsonObject(with: request.body ?? Data())) as? [String: Any]
        return (object?["kind"] as? String ?? "", (object?["command"] as? [String: Any])?["type"] as? String)
    }
}

enum Fixture {
    static let account = try! AccountID("acct")
    static let sonnet = CodeV2.ModelSelection(instanceId: "alevr", model: "claude-sonnet-5-5", effort: .medium)
    static let claudeSub = CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: .high)

    static func snapshot(
        id: String = "s1", state: CodeV2.SessionState = .idle, items: [CodeV2.TurnItem] = [],
        activeTurnId: String? = nil, title: String = "Fix the cart total"
    ) -> CodeV2.SessionSnapshot {
        CodeV2.SessionSnapshot(
            id: id, cwd: "/Users/me/code/shop", title: title, selection: sonnet, state: state,
            activeTurnId: activeTurnId, items: items
        )
    }

    static func envelope(_ sequence: Int, _ event: CodeV2.ServerEvent, session: String = "s1", at: String = "2026-10-10T10:00:00Z") -> CodeV2.ServerEventEnvelope {
        CodeV2.ServerEventEnvelope(sessionId: session, sequence: sequence, at: at, event: event)
    }

    static func summary(_ id: String, state: CodeV2.SessionState, updatedAt: String, title: String? = nil) -> CodeV2.SessionSummary {
        CodeV2.SessionSummary(id: id, cwd: "/Users/me/code/\(id)", title: title ?? id, state: state, selection: sonnet, updatedAt: updatedAt, lastSequence: 0)
    }

    static func approval(_ status: CodeV2.ApprovalRequest.Status, id: String = "a1") -> CodeV2.TurnItem {
        .approvalRequest(CodeV2.ApprovalRequest(
            id: id, turnId: "t1", createdAt: "2026-10-10T10:00:01Z", callId: "c1", requestId: "req-\(id)",
            action: .command, summary: "Run npm test", options: [.accept, .acceptForSession, .decline], status: status
        ))
    }

    static let providers: [CodeV2.ProviderInstance] = [
        CodeV2.ProviderInstance(
            id: "alevr", kind: .alevr, label: "Alevr", status: .ready,
            capabilities: CodeV2.ProviderCapabilities(steering: true, effortLevels: [.low, .medium, .high]),
            models: [CodeV2.ProviderModel(id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", isDefault: true)]
        ),
        CodeV2.ProviderInstance(
            id: "claude-agent:default", kind: .claudeAgent, label: "Claude (your subscription)", status: .ready,
            capabilities: CodeV2.ProviderCapabilities(steering: true, effortLevels: [.low, .medium, .high, .max]),
            models: [CodeV2.ProviderModel(id: "claude-opus-5-5", label: "Claude Opus 5.5", defaultEffort: .high)]
        ),
        CodeV2.ProviderInstance(
            id: "codex:default", kind: .codex, label: "ChatGPT (Codex)", status: .signedOut,
            models: [CodeV2.ProviderModel(id: "gpt-6.1", label: "GPT-6.1")]
        ),
    ]
}
