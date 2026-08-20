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
        /// Uploaded `Attachment` ids for the images/documents shown to the model on this
        /// turn. The server moves each one onto the message it creates, which is
        /// what puts the picture back in the conversation beside the words about
        /// it — without them a call where someone held up a receipt saves as a
        /// discussion of a receipt nobody can see.
        public let attachmentIDs: [String]

        /// The route's ceiling, and the relay's: four attachments to a turn.
        public static let maximumAttachments = 4

        /// - Parameter attachmentIDs: Clamped rather than validated. Every rule
        ///   the route enforces is enforced here first, because breaking one
        ///   fails the *whole* transcript with a 400 or a 409 — losing a
        ///   conversation the relay no longer holds, over an image.
        ///   Assistant turns carry none: the server claims attachments only onto
        ///   `USER` messages, but counts every id it was sent when checking they
        ///   are all available, so one hung on an assistant turn fails the save
        ///   and is never claimed anyway.
        public init(role: Role, content: String, attachmentIDs: [String] = []) {
            self.role = role
            self.content = content
            guard role == .user else {
                self.attachmentIDs = []
                return
            }
            var seen = Set<String>()
            self.attachmentIDs = Array(
                attachmentIDs
                    .filter { !$0.isEmpty && seen.insert($0).inserted }
                    .prefix(Self.maximumAttachments)
            )
        }

        private enum CodingKeys: String, CodingKey {
            case role, content, attachmentIds
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(role, forKey: .role)
            try container.encode(content, forKey: .content)
            // Omitted when empty, which is almost every turn of almost every
            // call: the route defaults the field, and a spoken conversation
            // should not carry an empty array on all two hundred of its lines.
            if !attachmentIDs.isEmpty {
                try container.encode(attachmentIDs, forKey: .attachmentIds)
            }
        }
    }

    public struct Saved: Equatable, Sendable {
        /// The conversation the turns landed in — the one that was open, or the
        /// one the server just created.
        public let conversationID: String
        public let messageCount: Int
        /// Kept for compatibility with older callers. A successful save never
        /// drops attachments; a conflict is a visible save failure.
        public let attachmentsDropped: Bool

        public init(
            conversationID: String,
            messageCount: Int,
            attachmentsDropped: Bool = false
        ) {
            self.conversationID = conversationID
            self.messageCount = messageCount
            self.attachmentsDropped = attachmentsDropped
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
    ///
    /// ## When attachments cannot be claimed
    ///
    /// The route attaches a file only while it is still unattached, and
    /// answers 409 for the whole transcript if any one of them has already been
    /// spoken for. That is a real state — the same picture staged into a typed
    /// message before the call ended, or a save that partially raced — and the
    /// route's transaction rolls back entirely when it happens.
    ///
    /// The relay keeps nothing to try again from, so a 409 remains a visible
    /// save failure. Retrying without the files would silently change what the
    /// model saw while still presenting a successful conversation.
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

        let response = try await post(
            sessionID: sessionID,
            conversationID: conversationID,
            modelID: modelID,
            projectID: projectID,
            connectors: connectors,
            turns: usable,
            for: accountID
        )

        return try saved(response, turnCount: usable.count, attachmentsDropped: false)
    }

    private func post(
        sessionID: UUID,
        conversationID: String?,
        modelID: String,
        projectID: String?,
        connectors: [String],
        turns: [Turn],
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        try await sender.send(
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
                        turns: turns
                    )
                )
            ),
            for: accountID
        )
    }

    private func saved(
        _ response: HTTPResponse,
        turnCount: Int,
        attachmentsDropped: Bool
    ) throws -> Saved {
        guard (200...299).contains(response.statusCode) else {
            throw failure(response)
        }
        guard let decoded = try? JSONDecoder().decode(ResponseWire.self, from: response.body),
            !decoded.conversationId.isEmpty
        else { throw NativeVoiceTranscriptError.malformedResponse }
        return Saved(
            conversationID: decoded.conversationId,
            messageCount: decoded.messages?.count ?? turnCount,
            attachmentsDropped: attachmentsDropped
        )
    }

    /// The route answers with Next's `{ "error": … }`, not the native envelope.
    private func failure(_ response: HTTPResponse) -> NativeVoiceTranscriptError {
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if response.statusCode == 409 {
            return .attachmentsUnavailable(
                message: message ?? "One or more voice attachments are unavailable."
            )
        }
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
    /// The route refused to claim an image (409) on a transcript that carried
    /// none to remove, so there was no smaller save to fall back to.
    case attachmentsUnavailable(message: String)
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .nothingToSave: "There was nothing said to save."
        case .malformedResponse: "Juno returned an invalid response saving the transcript."
        case .attachmentsUnavailable(let message): message
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
