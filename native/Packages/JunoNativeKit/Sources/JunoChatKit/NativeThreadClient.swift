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

// MARK: - Earlier versions

/// One earlier version of a message, as the server keeps it across regenerate
/// and edit-and-resend (`GET /api/messages/{id}/versions`, the web's
/// `ClientMessageVersionDetail`). The message row itself is always the newest
/// version; these are the older ones, oldest first, read only when the reader
/// steps back through the "‹ 2/3 ›" pager.
public struct NativeMessageVersion: Equatable, Sendable {
    public let id: String
    public let content: String
    public let reasoning: String?
    public let model: String?
    public let promptTokens: Int?
    public let completionTokens: Int?
    public let sources: [NativeChatSource]

    public init(
        id: String,
        content: String,
        reasoning: String? = nil,
        model: String? = nil,
        promptTokens: Int? = nil,
        completionTokens: Int? = nil,
        sources: [NativeChatSource] = []
    ) {
        self.id = id
        self.content = content
        self.reasoning = reasoning
        self.model = model
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.sources = sources
    }
}

extension NativeChatMessage {
    /// This message as it read at an earlier version — the web's `view` for a
    /// page of the version pager (`message-item.tsx`).
    ///
    /// The version's words, reasoning, model, tokens and sources replace the
    /// live ones. The run (activity and reasoning parts), the cost, the finish
    /// state and the error describe the **current** answer only, so they are
    /// cleared rather than inherited: an old answer captioned with the new
    /// answer's steps, or offering Continue for the new answer's token limit,
    /// would be describing something it is not.
    public func showing(_ version: NativeMessageVersion) -> NativeChatMessage {
        var copy = self
        copy.content = version.content
        copy.reasoning = version.reasoning
        copy.reasoningParts = nil
        copy.model = version.model
        copy.sources = version.sources
        copy.promptTokens = version.promptTokens
        copy.completionTokens = version.completionTokens
        copy.cacheReadTokens = nil
        copy.cacheWriteTokens = nil
        copy.costUSD = nil
        copy.activity = []
        copy.finishReason = nil
        copy.errorDescription = nil
        return copy
    }
}

extension NativeChatAPIClient {
    /// `GET /api/messages/{id}/versions`: the earlier versions of a message,
    /// oldest first.
    ///
    /// Strict about the list and lossy inside each version: a page's position
    /// is its index, so a version that could not be read fails the read rather
    /// than shifting every later page onto the wrong words. A malformed source
    /// costs only itself.
    public func messageVersions(
        messageID: String,
        for accountID: AccountID
    ) async throws -> [NativeMessageVersion] {
        try requireIdentifier(messageID)
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/messages/\(messageID)/versions"),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: MessageVersionsWire
        do { wire = try JSONDecoder().decode(MessageVersionsWire.self, from: response.body) }
        catch { throw NativeChatAPIError.malformedResponse }
        return try wire.versions.map { version in
            guard validText(version.id, maximum: 256) else { throw NativeChatAPIError.malformedResponse }
            return NativeMessageVersion(
                id: version.id,
                content: version.content,
                reasoning: version.reasoning,
                model: version.model,
                promptTokens: version.promptTokens,
                completionTokens: version.completionTokens,
                sources: (version.sources?.elements ?? []).prefix(100).compactMap { try? decodeSource($0) }
            )
        }
    }
}

private struct MessageVersionsWire: Decodable {
    struct VersionWire: Decodable {
        let id: String
        let content: String
        let reasoning: String?
        let model: String?
        let promptTokens: Int?
        let completionTokens: Int?
        let sources: LossyList<ChatSourceWire>?

        private enum CodingKeys: String, CodingKey {
            case id, content, reasoning, model, promptTokens, completionTokens, sources
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            content = try container.decode(String.self, forKey: .content)
            reasoning = try? container.decodeIfPresent(String.self, forKey: .reasoning)
            model = try? container.decodeIfPresent(String.self, forKey: .model)
            promptTokens = try? container.decodeIfPresent(Int.self, forKey: .promptTokens)
            completionTokens = try? container.decodeIfPresent(Int.self, forKey: .completionTokens)
            sources = try? container.decodeIfPresent(LossyList<ChatSourceWire>.self, forKey: .sources)
        }
    }

    let versions: [VersionWire]
}
