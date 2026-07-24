import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// The outcome of one naming attempt.
public struct NativeGeneratedTitle: Equatable, Sendable {
    public let title: String
    /// False when the server declined to rename — a manual title, no user turn
    /// yet, or a generated name identical to the one already stored. The caller
    /// must not animate a change that did not happen.
    public let renamed: Bool

    public init(title: String, renamed: Bool) {
        self.title = title
        self.renamed = renamed
    }
}

/// Asks the server to name a conversation from its opening turns.
///
/// This is the same `POST /api/conversations/{id}/title` the web client calls
/// from `chat-view.tsx`, and it is the server that decides whether a rename is
/// allowed at all: a title the reader typed (`titleSource: "manual"`) is never
/// overwritten, here or on the web. Keeping that judgement server-side is the
/// point — two clients guessing at it independently is how a hand-written title
/// gets clobbered from a phone.
public struct NativeConversationTitleClient: Sendable {
    /// The transcript sent as naming context. The route caps it at eight, and it
    /// reads the stored transcript itself when the client sends none, so this is
    /// an optimisation for the first turn — the message is often still in flight
    /// to the database when the request goes out.
    public struct ContextMessage: Sendable {
        public let role: String
        public let content: String

        public init(role: String, content: String) {
            self.role = role
            self.content = content
        }
    }

    public enum Phase: String, Sendable {
        case firstUser = "first_user"
        case completed
    }

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func generateTitle(
        conversationID: String,
        phase: Phase,
        messages: [ContextMessage],
        for accountID: AccountID
    ) async throws -> NativeGeneratedTitle? {
        guard !conversationID.isEmpty, conversationID.utf8.count <= 200,
            conversationID.rangeOfCharacter(from: .urlPathAllowed.inverted) == nil
        else { return nil }

        let body = RequestWire(
            phase: phase.rawValue,
            messages: messages.prefix(8).map {
                RequestWire.Message(role: $0.role, content: String($0.content.prefix(4_000)))
            }
        )
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/conversations/\(conversationID)/title",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        // Naming is best-effort by design: a 429 from the rate limiter or a 502
        // from the title model must never surface as a failure on a message that
        // sent perfectly well.
        guard (200...299).contains(response.statusCode),
            let wire = try? JSONDecoder().decode(ResponseWire.self, from: response.body),
            !wire.title.isEmpty, wire.title.utf8.count <= 400
        else { return nil }
        return NativeGeneratedTitle(title: wire.title, renamed: wire.renamed ?? false)
    }
}

private struct RequestWire: Encodable {
    struct Message: Encodable {
        let role: String
        let content: String
    }

    let phase: String
    let messages: [Message]
}

private struct ResponseWire: Decodable {
    let title: String
    let renamed: Bool?
}
