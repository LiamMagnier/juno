import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// Saves a spoken conversation into the account's chat history.
///
/// A voice session is a conversation, and it has to end up where every other
/// conversation is — searchable, in the sidebar, part of memory. The relay holds
/// the transcript only for the length of the call, so a session that is not
/// posted here is simply gone when the screen closes. The website has always
/// done this (`chat-view.tsx` posts the same body on hang-up); the phone did not,
/// which meant a spoken conversation left no trace at all.
///
/// Two properties of the route shape the client:
///
/// - **It is idempotent per `sessionId`.** A second POST with the same id
///   returns the *same* saved messages rather than duplicating the conversation,
///   which is what makes a retry safe after a dropped network.
/// - **`conversationId` is nullable, and that is the whole feature.** Sent, the
///   turns are appended to the chat that was open. Omitted, the server creates a
///   conversation for them. Nothing here decides which — the caller passes what
///   was on screen when the call started.
public struct NativeVoiceTranscriptClient: Sendable {
    public enum Role: String, Encodable, Sendable {
        case user = "USER"
        case assistant = "ASSISTANT"
    }

    public struct Turn: Encodable, Equatable, Sendable {
        public let role: Role
        public let content: String

        public init(role: Role, content: String) {
            self.role = role
            self.content = content
        }
    }

    public struct Saved: Equatable, Sendable {
        /// The conversation the turns landed in — the one that was open, or the
        /// one the server just created.
        public let conversationID: String
        public let messageCount: Int

        public init(conversationID: String, messageCount: Int) {
            self.conversationID = conversationID
            self.messageCount = messageCount
        }
    }

    /// The route's own ceiling, restated so an over-long session fails here
    /// rather than as a 400 after uploading everything.
    public static let maximumTurns = 1_000

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// - Parameters:
    ///   - sessionID: Stable for the life of one voice call, so a retry is
    ///     recognised as the same save rather than a second one.
    ///   - conversationID: The chat that was open, or nil to have one created.
    public func save(
        sessionID: UUID,
        conversationID: String?,
        modelID: String,
        projectID: String?,
        connectors: [String],
        turns: [Turn],
        for accountID: AccountID
    ) async throws -> Saved {
        let usable = Array(turns.prefix(Self.maximumTurns))
        guard !usable.isEmpty else { throw NativeVoiceTranscriptError.nothingToSave }

        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/voice/transcript",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(
                    RequestWire(
                        sessionId: sessionID.uuidString.lowercased(),
                        conversationId: conversationID,
                        model: modelID,
                        projectId: projectID,
                        // Omitted when empty: the route's schema caps this at
                        // five and an empty array is a claim of "no apps"
                        // rather than no claim.
                        connectors: connectors.isEmpty ? nil : Array(connectors.prefix(5)),
                        turns: usable
                    )
                )
            ),
            for: accountID
        )

        guard (200...299).contains(response.statusCode) else {
            throw failure(response)
        }
        guard let decoded = try? JSONDecoder().decode(ResponseWire.self, from: response.body),
            !decoded.conversationId.isEmpty
        else { throw NativeVoiceTranscriptError.malformedResponse }
        return Saved(
            conversationID: decoded.conversationId,
            messageCount: decoded.messages?.count ?? usable.count
        )
    }

    /// The route answers with Next's `{ "error": … }`, not the native envelope.
    private func failure(_ response: HTTPResponse) -> NativeVoiceTranscriptError {
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return .server(
            statusCode: response.statusCode,
            message: message
                ?? "Juno could not save this voice conversation (\(response.statusCode))."
        )
    }

}

public enum NativeVoiceTranscriptError: Error, Equatable, LocalizedError, Sendable {
    case nothingToSave
    case malformedResponse
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .nothingToSave: "There was nothing said to save."
        case .malformedResponse: "Juno returned an invalid response saving the transcript."
        case .server(_, let message): message
        }
    }
}

private struct RequestWire: Encodable {
    let sessionId: String
    let conversationId: String?
    let model: String
    let projectId: String?
    let connectors: [String]?
    let turns: [NativeVoiceTranscriptClient.Turn]
}

private struct ResponseWire: Decodable {
    struct Message: Decodable { let id: String }
    let conversationId: String
    let messages: [Message]?
}
