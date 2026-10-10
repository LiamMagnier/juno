import Foundation
import JunoAPI
import JunoAuth
import JunoCodeCore
import JunoCodeRuntime
import JunoCore
import JunoSync

/// The Alevr engine's reach into the reader's other conversations, through
/// Alevr's backend (src/lib/cross-conversation on the web):
/// GET /api/cross-messages/conversations, GET /api/cross-messages/read,
/// POST /api/cross-messages and POST /api/cross-messages/[id]/state.
///
/// A session speaks as itself: this Mac's device id and the session's own id,
/// which the backend resolves to its synced mirror. The backend checks both
/// ends belong to the signed-in account, and applies the hop, hourly and
/// duplicate limits; this client adds nothing it could get wrong.
public struct BackendCodeConversationClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending
    private let accountID: AccountID
    /// This Mac's paired device id, read when a request is made (pairing can
    /// happen after launch); nil until Remote hosting has paired it.
    private let deviceID: @Sendable () -> String?

    public init(
        sender: any NativeAuthenticatedRequestSending,
        accountID: AccountID,
        deviceID: @escaping @Sendable () -> String? = { UserDefaults.standard.string(forKey: "juno.code.deviceId") }
    ) {
        self.sender = sender
        self.accountID = accountID
        self.deviceID = deviceID
    }

    static let notPaired = CodeConversationRefusal(
        "This Mac is not paired with your account for Remote, so this session cannot reach your other conversations yet. Turn on Remote hosting in Settings › Code."
    )

    public func list(from sessionID: CodeSessionID, product: String?, project: String?, query: String?) async throws -> [CodeConversationSummary] {
        var items = [URLQueryItem(name: "envs", value: "1")]
        if let device = deviceID() {
            // Never this session itself: the backend knows it by its mirror's id.
            items.append(URLQueryItem(name: "excludeDevice", value: device))
            items.append(URLQueryItem(name: "excludeSession", value: sessionID.value))
        }
        if let product { items.append(URLQueryItem(name: "product", value: product)) }
        if let project, !project.isEmpty { items.append(URLQueryItem(name: "project", value: project)) }
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "query", value: query)) }
        let body: ListWire = try await get("/api/cross-messages/conversations", items)
        return body.conversations
    }

    public func read(from _: CodeSessionID, id: String, lastN: Int) async throws -> (title: String, messages: [CodeConversationExcerptMessage]) {
        let body: ReadWire = try await get(
            "/api/cross-messages/read",
            [URLQueryItem(name: "id", value: id), URLQueryItem(name: "last_n", value: String(lastN))]
        )
        return (body.title, body.messages)
    }

    public func send(
        from sessionID: CodeSessionID, title: String, to: String, message: String, notifyWhenIdle: Bool,
        chain: CodeConversationChain?, sentThisTurn: Int
    ) async throws -> CodeConversationSendResult {
        guard let device = deviceID() else { throw Self.notPaired }
        let request = SendWire(
            from: .init(title: title, code: .init(deviceId: device, sessionId: sessionID.value)),
            to: to,
            message: message,
            notifyWhenIdle: notifyWhenIdle,
            chain: chain.map { .init(chainId: $0.chainID, hop: $0.hop) },
            sentThisTurn: sentThisTurn
        )
        let body: SendResultWire = try await post("/api/cross-messages", request)
        return CodeConversationSendResult(
            linkID: body.linkId, status: body.status, targetTitle: body.target.title, targetRef: body.target.ref,
            hop: chain?.hop ?? 0, chainID: chain?.chainID
        )
    }

    /// What became of a message this Mac was handed: delivered, answered (its
    /// turn ended; a sender that asked gets its idle notice) or failed.
    public func report(linkID: String, status: String, error: String? = nil) async {
        _ = try? await post("/api/cross-messages/\(linkID)/state", StateWire(status: status, error: error)) as EmptyWire
    }

    // MARK: Transport

    private func get<T: Decodable>(_ path: String, _ query: [URLQueryItem]) async throws -> T {
        let response = try await sender.send(
            try NativeBearerRequest(path: path, method: .get, queryItems: query, headers: HTTPHeaders(["Accept": "application/json"])),
            for: accountID
        )
        return try decode(response.statusCode, response.body)
    }

    private func post<B: Encodable, T: Decodable>(_ path: String, _ body: B) async throws -> T {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path, method: .post,
                headers: HTTPHeaders(["Accept": "application/json", "Content-Type": "application/json"]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        return try decode(response.statusCode, response.body)
    }

    private func decode<T: Decodable>(_ status: Int, _ body: Data) throws -> T {
        guard (200...299).contains(status) else {
            let message = (try? JSONDecoder().decode(ErrorWire.self, from: body))?.error
            throw CodeConversationRefusal(message ?? "Alevr answered \(status).")
        }
        do {
            return try JSONDecoder().decode(T.self, from: body)
        } catch {
            throw CodeConversationRefusal("Alevr returned a response this Mac could not read.")
        }
    }

    // MARK: Wire

    struct ListWire: Decodable { let conversations: [CodeConversationSummary] }
    struct ReadWire: Decodable {
        let title: String
        let messages: [CodeConversationExcerptMessage]
    }
    struct SendWire: Encodable {
        struct From: Encodable {
            let title: String
            let code: Code
        }
        struct Code: Encodable {
            let deviceId: String
            let sessionId: String
        }
        struct Chain: Encodable {
            let chainId: String
            let hop: Int
        }
        let from: From
        let to: String
        let message: String
        let notifyWhenIdle: Bool
        let chain: Chain?
        let sentThisTurn: Int
    }
    struct SendResultWire: Decodable {
        struct Target: Decodable {
            let ref: String
            let title: String
        }
        let linkId: String
        let status: String
        let target: Target
    }
    struct StateWire: Encodable {
        let status: String
        let error: String?
    }
    struct EmptyWire: Decodable {}
    struct ErrorWire: Decodable { let error: String }
}
