import Foundation
import JunoAPI
import JunoAuth
import JunoCore

/// A message between this Chat and another of the reader's conversations
/// (src/lib/cross-conversation on the web): sent from here, received here, or
/// the idle notice a send asked for. The transcript draws it as its own
/// compact row, never as the reader's message.
public struct NativeCrossMessage: Equatable, Sendable, Identifiable {
    public enum Direction: String, Sendable {
        case received
        case sent
        case notice
    }

    public let id: String
    public let direction: Direction
    public let peerRef: String
    public let peerTitle: String
    public let peerProduct: String
    public let text: String
    public let status: String
    public let createdAt: Date
    public let read: Bool

    public init(
        id: String, direction: Direction, peerRef: String, peerTitle: String, peerProduct: String,
        text: String, status: String, createdAt: Date, read: Bool
    ) {
        self.id = id
        self.direction = direction
        self.peerRef = peerRef
        self.peerTitle = peerTitle
        self.peerProduct = peerProduct
        self.text = text
        self.status = status
        self.createdAt = createdAt
        self.read = read
    }

    /// The row's caption: "Sent to ‘…’", "From ‘…’", "‘…’ is idle again".
    public var line: String {
        let title = "‘\(peerTitle)’"
        switch direction {
        case .notice: return "\(title) is idle again"
        case .received: return "From \(title)"
        case .sent: return status == "failed" ? "Not delivered to \(title)" : "Sent to \(title)"
        }
    }

    /// The Chat conversation id when the other end is a Chat.
    public var peerChatID: String? {
        peerRef.hasPrefix("chat:") ? String(peerRef.dropFirst(5)) : nil
    }
}

public struct NativeCrossReplyOwed: Equatable, Sendable {
    public let linkID: String
    public let conversationID: String
}

extension NativeChatAPIClient {
    /// `GET /api/conversations/{id}/cross-messages`: the rows, oldest first.
    public func crossMessages(conversationID: String, for accountID: AccountID) async throws -> [NativeCrossMessage] {
        try requireIdentifier(conversationID)
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/conversations/\(conversationID)/cross-messages"),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
        guard let wire = try? JSONDecoder().decode(CrossListWire.self, from: response.body) else {
            throw NativeChatAPIError.malformedResponse
        }
        return wire.messages.compactMap { row in
            guard let direction = NativeCrossMessage.Direction(rawValue: row.direction),
                  let createdAt = parseDate(row.createdAt) else { return nil }
            return NativeCrossMessage(
                id: row.id, direction: direction, peerRef: row.peerRef, peerTitle: row.peerTitle,
                peerProduct: row.peerProduct, text: String(row.text.prefix(8_000)), status: row.status,
                createdAt: createdAt, read: row.read
            )
        }
    }

    /// `POST /api/conversations/{id}/cross-messages {read:true}`: the reader opened it.
    public func markCrossMessagesRead(conversationID: String, for accountID: AccountID) async throws {
        try requireIdentifier(conversationID)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/conversations/\(conversationID)/cross-messages",
                method: .post,
                headers: HTTPHeaders(["Content-Type": "application/json"]),
                body: Data(#"{"read":true}"#.utf8)
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
    }

    /// `GET /api/cross-messages/pending`: replies Chat conversations owe, and
    /// the ones with a message the reader has not opened.
    public func pendingCrossReplies(for accountID: AccountID) async throws -> (replies: [NativeCrossReplyOwed], unread: Set<String>) {
        let response = try await sender.send(try NativeBearerRequest(path: "/api/cross-messages/pending"), for: accountID)
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
        guard let wire = try? JSONDecoder().decode(PendingWire.self, from: response.body) else {
            throw NativeChatAPIError.malformedResponse
        }
        return (wire.replies.map { NativeCrossReplyOwed(linkID: $0.linkId, conversationID: $0.conversationId) }, Set(wire.unread))
    }

    /// Runs the reply a Chat owes another conversation's message:
    /// `POST /api/chat {conversationId, regenerate: true, crossReply: {linkId}}`.
    /// The server claims the message first, so a reply another device already
    /// started answers 404/409 and nothing runs twice. Returns whether it ran.
    @discardableResult
    public func runCrossReply(_ owed: NativeCrossReplyOwed, for accountID: AccountID) async -> Bool {
        guard (try? requireIdentifier(owed.conversationID)) != nil,
              let body = try? JSONEncoder().encode(CrossReplyWire(conversationId: owed.conversationID, crossReply: .init(linkId: owed.linkID)))
        else { return false }
        guard let request = try? NativeBearerRequest(
            path: "/api/chat", method: .post,
            headers: HTTPHeaders(["Content-Type": "application/json", "Accept": "text/event-stream"]),
            body: body
        ) else { return false }
        guard let response = try? await sender.send(request, for: accountID) else { return false }
        return (200...299).contains(response.statusCode)
    }

    struct CrossListWire: Decodable {
        struct Row: Decodable {
            let id: String
            let direction: String
            let peerRef: String
            let peerTitle: String
            let peerProduct: String
            let text: String
            let status: String
            let createdAt: String
            let read: Bool
        }
        let messages: [Row]
    }

    struct PendingWire: Decodable {
        struct Reply: Decodable {
            let linkId: String
            let conversationId: String
        }
        let replies: [Reply]
        let unread: [String]
    }

    struct CrossReplyWire: Encodable {
        struct Link: Encodable { let linkId: String }
        let conversationId: String
        var regenerate = true
        let crossReply: Link
        var client = "app"
    }
}
