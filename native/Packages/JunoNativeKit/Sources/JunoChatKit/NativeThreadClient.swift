import Foundation
import JunoAuth
import JunoCore

/// What a conversation's thread adds to the synced transcript: each message's
/// sources, run and reasoning parts, and the conversation's artifacts.
///
/// **Why a second read of the same messages.** The `message` sync entity
/// carries the words and the receipt, and not the sources or the activity —
/// so a reply's bibliography and its run vanished the moment the transcript
/// reloaded from sync after `done`. The web reads them from the thread
/// (`GET /api/conversations/{id}`, `getConversationThread`), and so does this:
/// laid over the synced rows by message id, with no change to the sync
/// entities.
public struct NativeConversationThread: Equatable, Sendable {
    public struct Message: Equatable, Sendable {
        public let id: String
        public let sources: [NativeChatSource]
        public let activity: [NativeChatActivity]
        public let reasoningParts: [String]?
        /// Earlier versions kept across regenerate and edit — metadata only.
        public let versionCount: Int

        public init(
            id: String,
            sources: [NativeChatSource],
            activity: [NativeChatActivity],
            reasoningParts: [String]?,
            versionCount: Int = 0
        ) {
            self.id = id
            self.sources = sources
            self.activity = activity
            self.reasoningParts = reasoningParts
            self.versionCount = versionCount
        }
    }

    public let messages: [Message]
    public let artifacts: [NativeStreamedArtifact]

    public init(messages: [Message], artifacts: [NativeStreamedArtifact]) {
        self.messages = messages
        self.artifacts = artifacts
    }
}

extension NativeChatAPIClient {
    /// `GET /api/conversations/{id}`, reduced to what the synced rows lack.
    ///
    /// Lossy by message and by field: a message this build cannot read keeps
    /// its synced self, and a malformed source or activity row costs only
    /// itself.
    public func conversationThread(
        conversationID: String,
        for accountID: AccountID
    ) async throws -> NativeConversationThread {
        try requireIdentifier(conversationID)
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/conversations/\(conversationID)"),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: ThreadWire
        do { wire = try JSONDecoder().decode(ThreadWire.self, from: response.body) }
        catch { throw NativeChatAPIError.malformedResponse }
        return NativeConversationThread(
            messages: wire.messages.elements.compactMap { message in
                guard validText(message.id, maximum: 256) else { return nil }
                return NativeConversationThread.Message(
                    id: message.id,
                    sources: (message.sources?.elements ?? []).prefix(100).compactMap { try? decodeSource($0) },
                    activity: (message.activity?.elements ?? []).compactMap { $0.activity(parseDate: parseDate) },
                    reasoningParts: message.reasoningParts,
                    versionCount: message.versions?.elements.count ?? 0
                )
            },
            artifacts: (wire.artifacts?.elements ?? []).compactMap(decodeArtifact)
        )
    }
}

private struct ThreadWire: Decodable {
    struct MessageWire: Decodable {
        struct VersionWire: Decodable { let id: String }

        let id: String
        let sources: LossyList<ChatSourceWire>?
        let activity: LossyList<NativeActivityWire>?
        let reasoningParts: [String]?
        let versions: LossyList<VersionWire>?

        private enum CodingKeys: String, CodingKey { case id, sources, activity, reasoningParts, versions }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            sources = try? container.decodeIfPresent(LossyList<ChatSourceWire>.self, forKey: .sources)
            activity = try? container.decodeIfPresent(LossyList<NativeActivityWire>.self, forKey: .activity)
            reasoningParts = try? container.decodeIfPresent([String].self, forKey: .reasoningParts)
            versions = try? container.decodeIfPresent(LossyList<VersionWire>.self, forKey: .versions)
        }
    }

    let messages: LossyList<MessageWire>
    let artifacts: LossyList<ChatArtifactWire>?

    private enum CodingKeys: String, CodingKey { case messages, artifacts }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messages = try container.decode(LossyList<MessageWire>.self, forKey: .messages)
        artifacts = try? container.decodeIfPresent(LossyList<ChatArtifactWire>.self, forKey: .artifacts)
    }
}
